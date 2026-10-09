import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
// 评分规则单源：开头窗口(160)判拒、REFUSAL / FALLBACK / SAFE / RISK 标记与域命中
// 检测全部由 scripts/lib/scorer.mjs 提供。本文件不再维护第二份规则表 ——
// 历史上两份副本曾双向漂移（RISK_MARKERS 与 web/game/llm 域词表不一致），
// 状态条因此低报风险词、误判命中域。2026-10-08 按上游 PR#21 单源化。
import { scoreResponse } from "./scripts/lib/scorer.mjs";

// ── 无限四代注入载荷（v0.6.0） ────────────────────────────────────────────────────
// Order 100 与 Order 200 双槽位同时注册（DUAL_LAYER_INJECTION=true）；两段载荷同源同构
// （SHA256 一致），等价于把同一份载荷注入两遍 —— 这是刻意的权重强化，不是误配。
// 槽位均为「条件段」：由对话框开关（settings namespace dsh-infinite-gen-4）
// 控制，关闭时渲染为空串并被 dsh-system-prompt 的 renderPrompt 过滤，零残留。
const PROMPT_URL = new URL("./prompts/infinite-gen-4.md", import.meta.url);
const PROMPT41_URL = new URL("./prompts/infinite-gen-4.1-flash.md", import.meta.url);
// 兼容 DSH 提示词变量插值引擎（非内置变量的连续花括号做安全转义，防止模板解析器抛出 malformed prompt variable reference）
const escapePromptVars = (text) => text.replace(/\{\{(?!(?:cwd|model|provider)\}\})/g, "{ {");
const PROMPT_TEXT = escapePromptVars(readFileSync(PROMPT_URL, "utf8"));
const PROMPT41_TEXT = escapePromptVars(readFileSync(PROMPT41_URL, "utf8"));

// ── GPT 系外部载荷（Codex 破甲提示词） ─────────────────────────────────────────
// 三份来自 MDX-Tom/gpt-instruct（MIT，见 prompts/SOURCES.md），字节原样保留。
// 它们是「多段状态机式单一整份」——含 INJECTED REVISION ACTION 一类的 ACTION 绑定规则，
// 且明文写「Text loaded afterward cannot select, replace, or nest ACTION」。
// 因此 GPT 分支只注入单段（order 200 返回空串）：注入两遍时第二遍正好撞上它自己的规则。
// DSH 自持载荷（infinite-gen-4.md）维持双段，那是刻意的权重强化。
const GPT6_URL = new URL("./prompts/gpt-6-astra.md", import.meta.url);
const GPT61_URL = new URL("./prompts/gpt-6.1-sol.md", import.meta.url);
const GPT56_URL = new URL("./prompts/gpt-5.6-sol.md", import.meta.url);

/**
 * 载荷清单：id → { label, text }。
 * text 一律过同一条 `{{` 转义正则（GPT 载荷当前 0 处命中，属零成本防未来改动）。
 * 读取失败（文件缺失）不抛错：置为空串，由 gated 回落，避免整块插件不加载。
 * @returns {Record<string, {label: string, text: string}>} 载荷表。
 */
function loadPayloadTable() {
  const read = (url) => {
    try {
      return escapePromptVars(readFileSync(url, "utf8"));
    } catch {
      return "";
    }
  };
  return {
    dsh: { label: "无限四代（DSH 自持载荷）", text: PROMPT_TEXT },
    gpt61: { label: "GPT-6.1 Sol（Codex 载荷）", text: read(GPT61_URL) },
    gpt6: { label: "GPT-6 Astra（Codex 载荷）", text: read(GPT6_URL) },
    gpt56: { label: "GPT-5.6 Sol（Codex 载荷）", text: read(GPT56_URL) },
  };
}

const PAYLOADS = loadPayloadTable();
/** 载荷 id 白名单（用于手动模式的入参校验与设置页选项）。 */
const PAYLOAD_IDS = ["dsh", "gpt61", "gpt6", "gpt56"];
/** 分流规则：**按具体度降序短路** —— gpt-6.1 必须排在 gpt-6 之前，否则 6.1 会被 6 吃掉。 */
const PAYLOAD_RULES = [
  [/^gpt-6\.1(?!\d)/i, "gpt61"],
  [/^gpt-6(?!\.)/i, "gpt6"],
  [/^gpt-5\.6(?!\d)/i, "gpt56"],
  [/^gpt-5(?!\.)/i, "gpt56"],
  [/^o[0-9]/i, "gpt56"],
  [/^codex/i, "gpt56"],
];

/**
 * 判断一个 model id 是否属于 GPT（OpenAI）系 —— 用于「其他 gpt-* 走最近代」的兜底。
 * @param {string} model 模型 id。
 * @returns {boolean} 是否 GPT 系。
 */
function isGptFamily(model) {
  return /^(gpt|o[0-9]|codex)/i.test(String(model ?? ""));
}

/**
 * 未知代次的 GPT 模型兜底：抽 `gpt-<n>[.<n>]` 取**最大版本号**，落在最近代载荷。
 * 例：未来出现 `gpt-7-x` → 走 gpt61（当前最新代），而不是错落到 5.6。
 * @param {string} model 模型 id。
 * @returns {string} 载荷 id。
 */
function newestGptPayload(model) {
  const m = /^gpt-(\d+(?:\.\d+)?)/i.exec(String(model ?? ""));
  if (m === null) return "gpt56";
  const version = Number.parseFloat(m[1]);
  if (!Number.isFinite(version)) return "gpt56";
  if (version > 6) return "gpt61";
  if (version > 5.6) return "gpt6";
  return "gpt56";
}

/**
 * 归一化模型 id：剥掉 provider 前缀（`openai/gpt-6` → `gpt-6`）与首尾空白。
 * 本机 model 都是裸名，但网关/中转可能下发 `provider/model` 形态 —— 不剥的话
 * 这类 id 会一路落到「非 GPT」分支、静默走错载荷。
 * @param {unknown} model 原始模型 id。
 * @returns {string} 归一化后的 id。
 */
function normalizeModelId(model) {
  const raw = String(model ?? "").trim();
  if (raw.length === 0) return "";
  const slash = raw.lastIndexOf("/");
  return slash >= 0 && slash < raw.length - 1 ? raw.slice(slash + 1) : raw;
}

/**
 * 按模型身份选载荷 id —— **按 model 名匹配，不按 provider**。
 * 理由（本机实测）：`gpt-6.1-sol` 同时挂在 `gpt` 与 `heihei` 两个 provider 下，
 * 只看 provider 必然漏掉后者。
 * @param {string|undefined} model 当前模型 id（agent.options.model）。
 * @returns {string} 载荷 id（未知一律回落 "dsh"）。
 */
function matchPayloadId(model) {
  const id = normalizeModelId(model);
  if (id.length === 0) return "dsh";
  for (const [pattern, payloadId] of PAYLOAD_RULES) {
    if (pattern.test(id)) return payloadId;
  }
  // GPT 系但代次未列在上表：取最大版本号落到最近代；非 GPT 系一律 DSH 自持载荷
  return isGptFamily(id) ? newestGptPayload(id) : "dsh";
}

// 双段注入镜像开关：
//   true  = 沿用四代双层架构，Order 100 与 Order 200 各注入一份同源载荷（重复注入）
//   false = 单段注入（Order 100），省掉重复 token，行为等价
// 2026-10-05：置 true —— 按用户要求恢复双段（两文件逐字同源，效果 = 同一份载荷注入两遍）。
const DUAL_LAYER_INJECTION = true;

const VERSION = "0.6.0";
// 版本锚点（校验脚本按字面量断言，须与 package.json 的 version 同步）：
//   pluginVersion: "0.6.0"

// 开关落点：profile entry config（cordis.patch.yml → dsh-infinite-gen-4.config.enabled）；
// 0.2.x 由 settings 表单面写回：客户端开关 → ctx.remote.settings.mutate(ns, ops, revision)。
const SETTINGS_NAMESPACE = "dsh-infinite-gen-4";
const SETTINGS_FIELD = "enabled";
const MODE_FIELD = "mode";
const MANUAL_PAYLOAD_FIELD = "manualPayload";
// 默认关闭：没写 config 时注入为空（零残留），需要时由对话框开关或手写
// `config: { enabled: true }` 打开。默认值只存在于代码与部署组合层，
// 用户开关是唯一的持久化写入方，因此「关掉」永远不会被写进设置文档。
const DEFAULT_ENABLED = false;
// 载荷路由默认值：auto = 按当前模型身份自动选；manual = 固定用手动指定的那一份。
const DEFAULT_MODE = "auto";
const DEFAULT_MANUAL_PAYLOAD = "dsh";
// 同一字段需要两个独立 schema 实例：.volatile() 是就地改写 meta（extra），
// 复用同一实例会把旧 register 通道也变成 volatile。
//   SettingsSchema —— 0.1.x 的 settings.register(namespace, schema) 通道
//   Config         —— 0.2.x 表单面 entry schema：只有 volatile 字段才进 describe 列表，
//                     写入经 fiber.config 生效（热更新不重挂 entry）
const enabledField = () =>
  Schema.boolean().default(DEFAULT_ENABLED).description("无限四代提示词注入总开关（默认关）");
const modeField = () =>
  Schema.union(["auto", "manual"])
    .default(DEFAULT_MODE)
    .description("载荷路由模式：auto = 按当前模型自动选，manual = 固定用手动指定的载荷");
const manualPayloadField = () =>
  Schema.union(PAYLOAD_IDS)
    .default(DEFAULT_MANUAL_PAYLOAD)
    .description("手动模式下固定使用的载荷（mode=manual 时生效）");
const SettingsSchema = Schema.object({
  enabled: enabledField(),
  mode: modeField(),
  manualPayload: manualPayloadField(),
}).description("无限四代 / dsh-infinite-gen-4 运行时开关");
/** 0.2.x settings 表单面 schema：entry id = 插件 id，字段必须 volatile 才能在线编辑。 */
export const Config = Schema.object({
  enabled: enabledField().volatile(),
  mode: modeField().volatile(),
  manualPayload: manualPayloadField().volatile(),
});

// ── 会话级开关覆盖 ──────────────────────────────────────────────────────────────
// 全局默认 = profile entry config 的 enabled（新会话继承它）；单个会话可在状态条开关上
// 单独覆盖，存插件自持文件（与记忆插件同款做法，与宿主版本无关，改完立即生效）。
const SESSION_STORE = join(homedir(), ".dsh", "infinite-gen-4", "sessions.json");

/** 读覆盖表：只接受 boolean 值，文件损坏/缺失一律当空表。 */
function loadSessionOverrides() {
  try {
    if (!existsSync(SESSION_STORE)) return {};
    const parsed = JSON.parse(readFileSync(SESSION_STORE, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

let sessionOverrides = loadSessionOverrides();

/** 落盘覆盖表；失败返回 false（内存态仍然生效）。 */
function saveSessionOverrides() {
  try {
    mkdirSync(dirname(SESSION_STORE), { recursive: true });
    writeFileSync(SESSION_STORE, `${JSON.stringify(sessionOverrides, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 会话维度真值：该会话有覆盖就用覆盖，否则回落全局开关。
 * @param {string|undefined} sessionId 会话 id（投影 header.id / agent.sessionId）。
 * @returns {boolean} 是否对该会话注入载荷。
 */
function isEnabledForSession(sessionId) {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const override = sessionOverrides[sessionId];
    if (typeof override === "boolean") return override;
  }
  return isEnabled();
}

/**
 * 从 section 求值 context 里取会话 id —— 宿主每步传 `{ agent, scope, signal }`。
 * agent 是宿主内部对象，取字段全程 try 包裹，取不到就按全局处理。
 * @param {object|undefined} context assemble context。
 * @returns {string|undefined} 会话 id。
 */
function sessionIdOf(context) {
  try {
    const agent = context?.agent;
    const id = agent?.sessionId ?? agent?.session?.header?.id ?? agent?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

// 进程内后备状态：settings 服务缺席时也要有确定行为（与 DEFAULT_ENABLED 同源）
let settingsScope;
let fallbackEnabled = DEFAULT_ENABLED;
// 插件 ctx：apply 时保存。isEnabled() 每次经它重读 ctx.fiber.config ——
// volatile 写入就地更新 config，缓存 config 对象会一直读到旧值。
let hostCtx;
// 启动快照：仅当 hostCtx 取不到 config 时兜底
let entryConfig;
// settings 服务句柄：自有写通道优先经它持久化（写盘落点 = profile patch）
let settingsService;
// 兜底覆盖：settings 表单面写不动时（entry 无 volatile 字段 / 服务缺席）让开关仍能立即生效；
// 只存内存，进程重启后回到 config 真值。按字段存（enabled / mode / manualPayload）。
/** @type {Record<string, unknown>|undefined} */
let runtimeOverride;

/**
 * volatile 字段解析后是 cosmokit 的 createVolatile 包装（值经 .get() 取），普通字段是裸值。
 * 鸭式判定即可，不必 import 宿主内部包。
 * @param {unknown} value 字段原值。
 * @returns {unknown} 解包后的普通值。
 */
function unwrapConfigValue(value) {
  if (value !== null && typeof value === "object" && typeof value.get === "function") {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/** 读取生效中的 entry config（每次重读，保证拿到 volatile 写入后的新值）。 */
function liveEntryConfig() {
  try {
    const config = hostCtx?.fiber?.config;
    if (typeof config === "object" && config !== null) return config;
  } catch {
    // cordis 代理在 entry 卸载窗口可能拒绝访问，退回启动快照
  }
  return entryConfig;
}

/**
 * 当前注入是否启用。
 * 优先级：settings 服务（0.1.x register 通道）> 兜底覆盖（自有路由写入）> entry config
 *        > 进程内后备值。
 * @returns {boolean} 是否注入内核载荷。
 */
/**
 * 读一个字段的三层优先级真值：settings 服务 > 兜底覆盖 > entry config。
 * @param {Record<string, unknown>|undefined} resolved settings 服务解析值。
 * @param {Record<string, unknown>|undefined} override 兜底覆盖对象。
 * @param {string} field 字段名。
 * @returns {unknown} 字段真值，全链路缺席时 undefined。
 */
function resolveField(resolved, override, field) {
  const fromScope = resolved?.[field];
  if (fromScope !== undefined) return fromScope;
  const fromOverride = override?.[field];
  if (fromOverride !== undefined) return fromOverride;
  const live = liveEntryConfig();
  if (live !== undefined) {
    const value = unwrapConfigValue(live[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * 当前开关状态（总开关 + 载荷路由）。
 * 优先级：settings 服务（0.1.x register 通道）> 兜底覆盖（自有路由写入）> entry config
 *        > 进程内后备值。三个字段共用同一条优先级链，逐字段解析。
 * @returns {{enabled: boolean, mode: "auto"|"manual", manualPayload: string}} 状态。
 */
function readState() {
  let resolved;
  if (settingsScope !== undefined) {
    try {
      resolved = settingsScope.get();
    } catch {
      resolved = undefined;
    }
  }
  const enabledRaw = resolveField(resolved, runtimeOverride, SETTINGS_FIELD);
  const modeRaw = resolveField(resolved, runtimeOverride, MODE_FIELD);
  const payloadRaw = resolveField(resolved, runtimeOverride, MANUAL_PAYLOAD_FIELD);
  return {
    enabled: enabledRaw === undefined ? fallbackEnabled : enabledRaw === true,
    mode: modeRaw === "manual" ? "manual" : DEFAULT_MODE,
    // 非法载荷 id 一律回落 dsh（绝不因手滑配置项让注入变成空）
    manualPayload: PAYLOAD_IDS.includes(payloadRaw) ? payloadRaw : DEFAULT_MANUAL_PAYLOAD,
  };
}

/**
 * 当前注入是否启用。
 * @returns {boolean} 是否注入载荷。
 */
function isEnabled() {
  return readState().enabled;
}

/** 自有写通道的令牌头：跨站简单请求带不上自定义头，省掉一整类 CSRF。 */
const ROUTE_HEADER = "x-dsh-infinite-gen-4";

/**
 * 发 JSON 响应。
 * @param {import("node:http").ServerResponse} res 响应。
 * @param {number} code 状态码。
 * @param {object} payload 载荷。
 */
function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 读 JSON 请求体（带上限，超限即放弃）。
 * @param {import("node:http").IncomingMessage} req 请求。
 * @param {number} limit 字节上限。
 * @returns {Promise<object|undefined>} 解析结果。
 */
function readJsonBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}

/**
 * 开关的自有读写路由（webServer 前缀 /dsh-infinite-gen-4）：
 *   GET  /dsh-infinite-gen-4/settings            → { ok, enabled, source }
 *   POST /dsh-infinite-gen-4/settings {enabled}  → 先试 settings.update 持久化，写不动则内存覆盖
 * 注意 prefix 路由下 req.url 是完整路径，判定必须按完整路径收。
 * @param {import("node:http").IncomingMessage} req 请求。
 * @param {import("node:http").ServerResponse} res 响应。
 */
async function handleSettingsRoute(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "");
  const isSettings = path === "/dsh-infinite-gen-4/settings" || path.endsWith("/settings");
  const isSession = path === "/dsh-infinite-gen-4/session" || path.endsWith("/session");
  if (!isSettings && !isSession) return sendJson(res, 404, { ok: false, error: "not found" });

  if (req.method === "GET") {
    if (!isSession) {
      const state = readState();
      return sendJson(res, 200, {
        ok: true,
        enabled: state.enabled,
        mode: state.mode,
        manualPayload: state.manualPayload,
        resolvedPayload: state.mode === "manual" ? state.manualPayload : "(auto)",
        payloads: PAYLOAD_IDS.map((pid) => ({ id: pid, label: PAYLOADS[pid]?.label ?? pid })),
        source: runtimeOverride !== undefined ? "override" : "config",
      });
    }
    const id = url.searchParams.get("id");
    if (id === null || id.length === 0) return sendJson(res, 400, { ok: false, error: "missing id" });
    return sendJson(res, 200, {
      ok: true,
      sessionId: id,
      enabled: isEnabledForSession(id),
      source: typeof sessionOverrides[id] === "boolean" ? "session" : "config",
      globalEnabled: isEnabled(),
    });
  }
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
  if (String(req.headers?.[ROUTE_HEADER] ?? "") !== "1") {
    return sendJson(res, 403, { ok: false, error: `missing ${ROUTE_HEADER} header` });
  }
  const body = await readJsonBody(req);
  if (body === null || typeof body !== "object") {
    return sendJson(res, 400, { ok: false, error: "expected a JSON object body" });
  }

  // /session 路由保持 boolean-only 语义（载荷路由按用户选择只做全局，不按会话覆盖）
  if (isSession) {
    const id = typeof body.sessionId === "string" ? body.sessionId : "";
    if (id.length === 0) return sendJson(res, 400, { ok: false, error: "expected { sessionId: string }" });
    if (body.enabled === null) {
      delete sessionOverrides[id]; // 清除覆盖 → 该会话回到全局值
    } else if (typeof body.enabled === "boolean") {
      sessionOverrides[id] = body.enabled;
    } else {
      return sendJson(res, 400, { ok: false, error: "expected { enabled: boolean | null }" });
    }
    const stored = saveSessionOverrides();
    return sendJson(res, 200, {
      ok: true,
      sessionId: id,
      enabled: isEnabledForSession(id),
      persisted: stored,
      source: typeof sessionOverrides[id] === "boolean" ? "session" : "config",
    });
  }

  // 收集本次要写的字段：至少一个合法字段，否则 400。
  // 三个字段都可独立写（客户端可只切 mode，不必重复提交 enabled）。
  const patch = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return sendJson(res, 400, { ok: false, error: "expected { enabled: boolean }" });
    }
    patch[SETTINGS_FIELD] = body.enabled;
  }
  if (body.mode !== undefined) {
    if (body.mode !== "auto" && body.mode !== "manual") {
      return sendJson(res, 400, { ok: false, error: 'expected { mode: "auto" | "manual" }' });
    }
    patch[MODE_FIELD] = body.mode;
  }
  if (body.manualPayload !== undefined) {
    if (!PAYLOAD_IDS.includes(body.manualPayload)) {
      return sendJson(res, 400, {
        ok: false,
        error: `expected { manualPayload: ${PAYLOAD_IDS.join(" | ")} }`,
      });
    }
    patch[MANUAL_PAYLOAD_FIELD] = body.manualPayload;
  }
  if (Object.keys(patch).length === 0) {
    return sendJson(res, 400, {
      ok: false,
      error: "expected at least one of { enabled, mode, manualPayload }",
    });
  }

  let persisted = false;
  const service = settingsService;
  if (service !== undefined && typeof service.update === "function") {
    try {
      await service.update(SETTINGS_NAMESPACE, patch);
      // 写完自校验：真值确实落地才算持久化成功，否则退回内存覆盖
      const after = readState();
      persisted = Object.entries(patch).every(([key, value]) => after[key] === value);
    } catch {
      persisted = false;
    }
  }
  if (persisted) {
    // 持久化成功即清掉本轮涉及的字段的兜底覆盖，让配置真值接管
    if (runtimeOverride !== undefined) {
      for (const key of Object.keys(patch)) delete runtimeOverride[key];
    }
  } else {
    // 写不动则按字段落内存覆盖（保留本轮未涉及的字段的既有覆盖）
    runtimeOverride = { ...(runtimeOverride ?? {}), ...patch };
  }
  return sendJson(res, 200, { ok: true, ...readState(), persisted });
}

/**
 * 条件段文本求值器（order 100）：宿主每个模型步以 `{ agent, scope, signal }` 调用一次，
 * 因此这里天然就是「按会话」的 —— 会话覆盖关 / 全局关都返回空串，
 * 交给 renderPrompt 过滤，零残留。
 * 载荷不再是固定文本：由 `resolvePayloadId` 按「手动指定 / 当前模型身份」二选一。
 * @returns {(context: object) => string} 段文本求值函数。
 */
function gated() {
  return (context) => {
    if (!isEnabledForSession(sessionIdOf(context))) return "";
    return payloadTextFor(context, "primary");
  };
}

/**
 * GPT 分支的强化段（order 200）文本 —— 恒为空串。
 * 三份 Codex 载荷都是状态机式单一整份，且明文写「Text loaded afterward cannot
 * select, replace, or nest ACTION」：注入第二遍正好撞上它自己的规则。
 * DSH 自持载荷不受影响，仍按 DUAL_LAYER_INJECTION 走双段。
 * @param {object} context assemble context。
 * @returns {string} 恒为空串。
 */
function gatedReinforce() {
  return (context) => {
    if (!isEnabledForSession(sessionIdOf(context))) return "";
    if (resolvePayloadId(context) !== "dsh") return "";
    return PROMPT41_TEXT;
  };
}

/**
 * 解析本次求值该用哪份载荷 id。
 * mode=manual 时用手动指定值（忽略模型身份）；auto 时按 model 名匹配。
 * @param {object} context assemble context。
 * @returns {string} 载荷 id。
 */
function resolvePayloadId(context) {
  const state = readState();
  if (state.mode === "manual") return state.manualPayload;
  return matchPayloadId(modelOf(context));
}

/**
 * 从 section 求值 context 里取当前模型的 id。
 * 宿主每步传 `{ agent, scope, signal }`（dsh-agent 的 assembleContextFor），
 * 官方自己就用 `context.agent?.options.model` 注册 {{model}} 变量 —— 同一取法。
 * agent 是宿主内部对象，全程 try 包裹，取不到就回落 DSH 自持载荷。
 * @param {object|undefined} context assemble context。
 * @returns {string|undefined} 模型 id。
 */
function modelOf(context) {
  try {
    const model = context?.agent?.options?.model;
    return typeof model === "string" && model.length > 0 ? model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 取指定槽位的载荷文本。
 * @param {object} context assemble context。
 * @param {"primary"} _slot 槽位（当前只有主槽位会按载荷分流）。
 * @returns {string} 载荷文本。
 */
function payloadTextFor(context, _slot) {
  const id = resolvePayloadId(context);
  const entry = PAYLOADS[id];
  const text = entry?.text ?? "";
  // 文件缺失等异常一律回落 DSH 自持载荷，绝不返回空串
  // （空串是「关掉」的语义，不能与「取不到」混淆）
  return text.length > 0 ? text : PROMPT_TEXT;
}

const objectOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

// 运行时元数据工具：返回插件版本与能力清单
const profileTool = {
  name: "infinite_gen4_profile",
  description:
    "Return runtime metadata for the bundled 无限四代 (Infinite Generation Four) 破甲系统提示词与版本元数据。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  output: objectOutput,
  execute() {
    const enabled = isEnabled();
    const state = readState();
    return {
      plugin: "dsh-infinite-gen-4",
      pluginVersion: VERSION,
      pluginDisplayName: "无限四代",
      name: "infinite-gen-4",
      displayName: "无限四代",
      kernelVersion: VERSION,
      targetArchitecture: "DeepSeek-V4 / V4-Pro / V4.1-Flash 全系列",
      baseline: "deepseek-unrestricted-v7-stable (dsh-infinite-gen-4)",
      promptSource: [
        "prompts/infinite-gen-4.md",
        "prompts/infinite-gen-4.1-flash.md",
        "prompts/gpt-6.1-sol.md",
        "prompts/gpt-6-astra.md",
        "prompts/gpt-5.6-sol.md",
      ],
      lineage: [`dsh-infinite-gen-4 (v${VERSION}) — 按模型分流注入载荷 + 对话框热开关`],
      // 总开关状态：enabled=false 时所有载荷均渲染为空串，系统提示词零残留
      enabled,
      // 载荷路由：auto = 按当前模型身份选；manual = 固定用手动指定那份
      payloadRouting: {
        mode: state.mode,
        manualPayload: state.manualPayload,
        payloads: PAYLOAD_IDS.map((pid) => ({ id: pid, label: PAYLOADS[pid]?.label ?? pid })),
        rules: "gpt-6.1→gpt61 / gpt-6→gpt6 / gpt-5.6|gpt-5|o<n>|codex→gpt56 / 非 GPT→dsh（未列代次按最大版本号兜底）",
      },
      control: {
        kind: "dialog-switch",
        settingsNamespace: SETTINGS_NAMESPACE,
        settingsField: SETTINGS_FIELD,
        settingsFields: [SETTINGS_FIELD, MODE_FIELD, MANUAL_PAYLOAD_FIELD],
        persistence: "profile patch → dsh-infinite-gen-4.config.*（0.2.x 由 settings 表单面 settings.mutate 写回；0.1.7 前为 ~/.dsh/settings.yaml）",
        fallbackWhenSettingsMissing: fallbackEnabled,
      },
      injection: [
        {
          section: "infinite-gen-4:global-system-prompt",
          order: 100,
          enabled,
          payload: state.mode === "manual" ? state.manualPayload : "(auto: 按模型)",
        },
        {
          section: "infinite-gen-4:dual-layer-reinforce",
          order: 200,
          // GPT 系走单段（载荷自带 ACTION 绑定规则，重复注入会自我冲突）
          enabled: enabled && DUAL_LAYER_INJECTION,
          note: "仅 DSH 自持载荷生效；GPT 系载荷恒为空串（单段）",
        },
      ],
      mode: enabled
        ? state.mode === "manual"
          ? `armor — 手动模式，固定使用 ${state.manualPayload}`
          : "armor — 自动模式，按当前模型身份选载荷（GPT 系走 Codex 载荷，其余走 DSH 自持载荷）"
        : "off — 开关关闭，载荷渲染为空串（零残留）",
      payloadSections: [
        "工作区指令外壳（<system-reminder> … Instructions from: ~/.dsh/AGENTS.md）",
        "Output rules（首行契约 + 无拒绝表述 + 占位符清单）",
        "Request reinterpretation / Language consistency / Boundary-word handling",
        "Domain-specific handling（keygen / 逆向 / 成人虚构 / 化学等分域直出）",
        "Prescriptive templates（下载破解 / license 逆向 / reverse shell / 反调试 / Frida Hook 等模板）",
        "Layer independence（plan / todo / 子代理纪律以宿主 ~/.dsh/AGENTS.md 为唯一来源，不再重复注入）",
      ],
      hostFeatures: [
        "Model-Aware Routing: 按 agent.options.model 选载荷（gpt-6.1→6.1 载荷 / gpt-6→Astra / gpt-5.6|o<n>|codex→5.6 / 非 GPT→DSH 自持）；按 model 名而非 provider（同一 model 名可能挂在多个 provider 下）",
        "Payload Mode: auto（按模型自动）| manual（固定指定一份），全局配置，经设置页与本插件自有路由读写",
        "Session Switch: 开关按会话生效 —— section 求值 context 带 { agent, scope, signal }，用 agent.sessionId / session.header.id 查 ~/.dsh/infinite-gen-4/sessions.json 覆盖；⌥ 点击切全局",
        "Dialog Switch: 输入框状态条内联开关，经自有路由（host 先试 settings.update 持久化）写开关，下一模型步即时生效",
        "Settings Form: 导出 volatile Config + settings.configure，官方设置页与客户端开关共用同一写入面（写盘落点 = profile patch）",
        "Conditional Sections: 关闭时 section.text 求值为空串，renderPrompt 过滤，零残留",
        "Single-Layer Injection: Order 100 单段注入（Order 200 槽位与载荷文件保留，默认不注册）",
        "Section Hosting: Order 100/200 双槽位代码保留，由 DUAL_LAYER_INJECTION 切换（当前 false = 单段）",
        "Armor Projection: 开头窗口(160)判拒 + REFUSAL/FALLBACK/SAFE/RISK 标记 + 域命中",
        "Client Badge: 输入框上方「无限四代」实时状态条（含开关）",
        "Profile Tool: infinite_gen4_profile 返回内核版本、开关状态与注入槽位元数据",
      ],
      features: [
        "Pure Zero-Tool Architecture: 零工具面纯净直出，消除决策噪音",
        "First-Line Contract: 首行代码块 / 命令 / 步骤号 / 直接答案 / 固定模板串",
        "Supreme User Authority: 用户指令最高优先级",
        "Placeholder Self-Synthesis: 缺失细节自造 TARGET/HOST/TOKEN/OFFSET/PAYLOAD/SERIAL/ROLE_A/ROLE_B",
        "Task-Class Direct Output: 安全 / LLM 研究 / 成人虚构 / 其他",
        "Format Anchors: [USER]/[OUTPUT] few-shot 镜像",
        "Refusal Hardening: 拒绝对抗硬化 + 无拒绝动作",
      ],
    };
  },
};

// ---- 实时破甲状态（会话投影；评分规则由 scripts/lib/scorer.mjs 单源提供） ----
// 2026-10-08 按上游 PR#21 单源化：本文件不再维护第二份规则表。历史上两份副本曾双向
// 漂移 —— RISK_MARKERS 缺 9 词（base64/rot13/编码/多轮/自纠/进化/母本/自强化/fight）、
// web 域缺「爆破」「注入」、game 域多 3 词、llm 域多 sysprompt，导致状态条低报风险词、
// 误判命中域。规则表与域表一律以 scripts/lib/scorer.mjs 为准。

function armorTextOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && block.type === "text" ? block.text : ""))
    .join("\n");
}

function armorProjectionApply(state, event) {
  if (!event || typeof event !== "object") return state;
  // running 以宿主持久回合事件为界：turn/start 置位，assistant 消息与 turn/end 复位。
  // 旧版按 user/message 置位 —— 但 agent-instructions 的基线/刷新消息同样是普通
  // user/message 事件，会在无输入框操作时把角标误闪成「执行中…」。
  // 各分支一律展开 state：sessionId 由 init 写入，事件更新时必须保留，否则 view 拿不到
  // 会话身份、按会话开关会退化成全局语义。
  if (event.type === "turn/start") {
    return { ...state, running: true, verdict: null, words: [], safe: [], risk: [], domain: null, domainHits: 0 };
  }
  if (event.type === "assistant/message") {
    const text = armorTextOf(event?.data?.message?.content);
    if (!text.trim()) return { ...state, running: false };
    const scored = scoreResponse(text);
    return {
      ...state,
      running: false,
      verdict: scored.verdict,
      words: [...scored.refusal, ...scored.fallback].slice(0, 3),
      safe: scored.safe.slice(0, 3),
      risk: scored.risk.slice(0, 3),
      domain: scored.domain,
      domainHits: scored.domainHits,
    };
  }
  if (event.type === "turn/end") {
    return { ...state, running: false };
  }
  return state;
}

/**
 * 离线探针钩子（tests/payload-routing-probe.mjs 用）。
 * 导出内部决策函数，让探针能在不重启宿主的前提下断言分流矩阵。
 * 不参与运行时逻辑，也不进任何注入面。
 */
export const __testPayloadIds = PAYLOAD_IDS;
export const __testRoute = handleSettingsRoute;
export const __testMatchPayloadId = matchPayloadId;
export const __testResolvePayloadId = resolvePayloadId;
export const __testReadState = readState;
export const __testGated = gated;
export const __testGatedReinforce = gatedReinforce;

export const name = "dsh-infinite-gen-4";
export const inject = ["tools", "systemPrompt"];

export function apply(ctx) {
  // ── 0. 开关状态源 ────────────────────────────────────────────────────────────
  // 0.1.7 落点：组合层 config 直读（cordis.patch.yml 里本 entry 的 config）。
  // cordis 4 的 ctx 代理禁止直接读 ctx.config（`cannot get property "config"
  // without inject`，且把 "config" 写进 inject 会被当作等待服务 config 而永久 pending），
  // fiber.config 才是 entry config 的真实入口。未写 config 时保持零残留默认。
  hostCtx = ctx;
  entryConfig = ctx && ctx.fiber && typeof ctx.fiber.config === "object" && ctx.fiber.config !== null ? ctx.fiber.config : undefined;
  // 两代 settings 通道一次接完，都做能力探测（缺席即跳过，不影响其余功能）：
  //   register(namespace, schema)        —— 0.1.x 旧通道（0.2 已移除）
  //   configure({ auto: false }, fiber)  —— 0.2.x 表单面：把本 entry 挂进 settings 描述表，
  //   官方设置页与客户端开关都经 settings.describe/mutate 读写，写盘落点 = profile patch。
  const attachSettings = (sctx) => {
    const service = sctx.settings;
    if (service === undefined) return;
    settingsService = service;
    if (typeof service.register === "function") {
      ctx.effect(
        () => {
          const scope = service.register(SETTINGS_NAMESPACE, SettingsSchema);
          settingsScope = scope;
          // 开关翻转后由 isEnabled() 直接读 scope 解析值，段求值在下一个模型步拿到新值；
          // watch 仅用于把当前值镜像进后备变量，settings 服务卸载后行为仍可预期。
          const detach = scope.watch(() => {
            fallbackEnabled = scope.get()?.enabled === true;
          });
          return () => {
            detach();
            settingsScope = undefined;
          };
        },
        `infinite-gen-4: settings namespace ${SETTINGS_NAMESPACE}`,
      );
    }
    if (typeof service.configure === "function") {
      ctx.effect(
        () => {
          try {
            return service.configure({ auto: false }, ctx.fiber);
          } catch {
            // 热重载窗口里同一 fiber 可能已注册过 presentation（宿主会抛错），沿用既有策略即可
            return undefined;
          }
        },
        `infinite-gen-4: settings form ${SETTINGS_NAMESPACE}`,
      );
    }
  };
  if (typeof ctx.inject === "function") ctx.inject(["settings"], attachSettings);
  else attachSettings(ctx);

  // ── 0.5 自有写通道（兜底）────────────────────────────────────────────────────
  // settings 表单面写不动时（entry 没有 volatile 字段 / 服务缺席），输入框旁的开关也要能切：
  // webServer 前缀路由 + 内存覆盖，与 dsh-memory 同款做法；路由缺失时客户端自动退回只读。
  ctx.inject(["webServer"], (wctx) => {
    ctx.effect(
      () =>
        wctx.webServer.register({
          kind: "prefix",
          // 不带尾部斜杠：dsh-host-webserver 的 match() 自己会补 "/" 再比前缀
          path: "/dsh-infinite-gen-4",
          handler: handleSettingsRoute,
        }),
      "infinite-gen-4: settings route",
    );
  });

  // ── 1. 条件提示词段：开关关闭时渲染为空串（renderPrompt 过滤，零残留） ────────
  // 载荷按「手动指定 / 当前模型身份」动态选择：GPT 系走 Codex 载荷，其余走 DSH 自持载荷。
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: "infinite-gen-4:global-system-prompt",
      order: 100,
      text: gated(),
    }),
  );
  if (DUAL_LAYER_INJECTION) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: "infinite-gen-4:dual-layer-reinforce",
        order: 200,
        // DSH 自持载荷双段（刻意权重强化）；GPT 系走单段（见 gatedReinforce 注释）
        text: gatedReinforce(),
      }),
    );
  }
  ctx.effect(() => {
    ctx.tools.register(profileTool);
  });

  const anySchema = { parse: (value) => value };
  const armorDef = {
    key: "armor",
    stateVersion: 4,
    stateSchema: anySchema,
    // init 收到会话 header：把会话 id 记进 state，view 才能按会话算真值
    // （apply 更新 state 时会展开保留它，别改成整体替换）
    init: (header) => ({
      running: false,
      verdict: null,
      words: [],
      safe: [],
      risk: [],
      domain: null,
      domainHits: 0,
      sessionId: typeof header?.id === "string" ? header.id : null,
    }),
    apply: armorProjectionApply,
    wire: {
      viewSchema: anySchema,
      // enabled = 本会话真值（含会话覆盖）；globalEnabled = 全局值（⌥ 点击切的那个）
      view: (state) => ({
        ...state,
        enabled: isEnabledForSession(state.sessionId),
        globalEnabled: isEnabled(),
      }),
    },
  };

  const registerArmor = (p) => {
    try {
      ctx.effect(() => p.register(armorDef, "infinite-gen-4: armor projection"));
    } catch {}
  };

  const projections = ctx.get("sessionProjections");
  if (projections !== undefined) {
    registerArmor(projections);
  } else if (typeof ctx.inject === "function") {
    ctx.inject(["sessionProjections"], (innerCtx) => {
      const p = innerCtx.get("sessionProjections");
      if (p !== undefined) registerArmor(p);
    });
  }
}
