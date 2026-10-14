import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
// 评分规则单源：开头窗口(160)判拒、REFUSAL / FALLBACK / SAFE / RISK 标记与域命中
// 检测全部由 scripts/lib/scorer.mjs 提供。本文件不再维护第二份规则表 ——
// 历史上两份副本曾双向漂移（RISK_MARKERS 与 web/game/llm 域词表不一致），
// 状态条因此低报风险词、误判命中域。2026-10-08 规则表单源化。
import { scoreResponse } from "./scripts/lib/scorer.mjs";

// ── Switch Armor注入载荷（v0.7.0） ────────────────────────────────────────────────────
// Order 主槽位与镜像槽位同时注册（DUAL_LAYER_INJECTION=true），
// 两者 order 落在 persona(0) 与 dsh-memory(1) 之间的夹缝里（见 PRIMARY_SECTION_ORDER 注释）。
// **双段只留给两份自持稿**（dsh / dsh-gen4），两段同源逐字一致 —— 刻意的权重强化。
// 外部稿（Codex 三份 + claude + grok）一律单段：它们要么含 ACTION 绑定并写明
// 「Text loaded afterward cannot select, replace, or nest ACTION」，要么首尾自带
// <|im_start|>system / <|im_end|> 闭合标签，注入两遍会自伤。
// 槽位均为「条件段」：由对话框开关（settings namespace dsh-switch-armor）
// 控制，关闭时渲染为空串并被 dsh-system-prompt 的 renderPrompt 过滤，零残留。
//
// 0.7.0 起：自持档 `dsh` 换成 Keysmith 的短稿 `dsh-unrestricted.md`；
// 原 7739B 分域契约稿降为 `dsh-gen4`（仅手动模式可选中，供随时切回）。
const PROMPT_URL = new URL("./prompts/dsh-unrestricted.md", import.meta.url);
const PROMPT_GEN4_URL = new URL("./prompts/infinite-gen-4.md", import.meta.url);
const PROMPT41_URL = new URL("./prompts/infinite-gen-4.1-flash.md", import.meta.url);
// 兼容 DSH 提示词变量插值引擎（非内置变量的连续花括号做安全转义，防止模板解析器抛出 malformed prompt variable reference）
const escapePromptVars = (text) => text.replace(/\{\{(?!(?:cwd|model|provider)\}\})/g, "{ {");
const PROMPT_TEXT = escapePromptVars(readFileSync(PROMPT_URL, "utf8"));
const PROMPT_GEN4_TEXT = escapePromptVars(readFileSync(PROMPT_GEN4_URL, "utf8"));
const PROMPT41_TEXT = escapePromptVars(readFileSync(PROMPT41_URL, "utf8"));

// ── 外部载荷（Codex 三份 + Keysmith 的 claude / grok） ──────────────────────────
// 三份 Codex 稿来自 MDX-Tom/gpt-instruct（MIT），claude / grok 两份来自 Jia-Ethan 的
// Keysmith 系列（MIT）—— 来源、许可与 sha256 见 prompts/SOURCES.md，字节原样保留。
// 它们是「多段状态机式单一整份」：Codex 三份含 INJECTED REVISION ACTION 一类的 ACTION
// 绑定并写明「Text loaded afterward cannot select, replace, or nest ACTION」；
// grok 稿首尾自带 <|im_start|>system / <|im_end|> 闭合标签。
// 因此**外部稿一律只注入单段**（镜像槽位返回空串）：注入两遍会自伤。
// 双段只留给两份自持稿（dsh / dsh-gen4），那是刻意的权重强化。
const GPT6_URL = new URL("./prompts/gpt-6-astra.md", import.meta.url);
const GPT61_URL = new URL("./prompts/gpt-6.1-sol.md", import.meta.url);
const GPT56_URL = new URL("./prompts/gpt-5.6-sol.md", import.meta.url);
const CLAUDE_KS_URL = new URL("./prompts/claude-keysmith.md", import.meta.url);
const GROK_KS_URL = new URL("./prompts/grok-keysmith.md", import.meta.url);
// glm：ZCode 系载荷（ZCode 是 GLM 的 CLI），来自 Jia-Ethan/zcode-keysmith ·
// examples/system-role.md（MIT），字节原样收编（sha256 见 prompts/SOURCES.md）。
const GLM_KS_URL = new URL("./prompts/glm-keysmith.md", import.meta.url);
// kimi：来自 YD-233/kimi-break · SYSTEM.md（MIT）。上游是 Kimi Code 的整份 SYSTEM.md
// 替换，含 12 个 Kimi Code 宿主模板变量（${os}/${cwd}/${agents_md}…）与三段宿主专属段
// （Working Environment / Context Management / Project Information）—— DSH 不展开这些
// 变量，直接注入会让模型把模板占位符当待填槽位。收编时剥掉占位符行与那三段，
// 破甲内核逐字保留；上游原文 sha256 与适配说明见 prompts/SOURCES.md。
const KIMI_BRK_URL = new URL("./prompts/kimi-break.md", import.meta.url);

/**
 * 载荷清单：id → { label, text }。
 * text 一律过同一条 `{{` 转义正则（当前六份外部载荷全 0 处命中，属零成本防未来改动）。
 * 读取失败（文件缺失）不抛错：置为空串，由 payloadTextFor 按 id 回落，避免整块插件不加载。
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
    dsh: { label: "dsh（Keysmith 短稿）", text: PROMPT_TEXT },
    "dsh-gen4": { label: "Switch Armor（原自持契约稿）", text: read(PROMPT_GEN4_URL) },
    gpt61: { label: "GPT-6.1 Sol（Codex 载荷）", text: read(GPT61_URL) },
    gpt6: { label: "GPT-6 Astra（Codex 载荷）", text: read(GPT6_URL) },
    gpt56: { label: "GPT-5.6 Sol（Codex 载荷）", text: read(GPT56_URL) },
    claude: { label: "Claude（Keysmith 载荷）", text: read(CLAUDE_KS_URL) },
    grok: { label: "Grok（Keysmith 载荷）", text: read(GROK_KS_URL) },
    glm: { label: "GLM（ZCode 载荷）", text: read(GLM_KS_URL) },
    kimi: { label: "Kimi（kimi-break 载荷）", text: read(KIMI_BRK_URL) },
  };
}

const PAYLOADS = loadPayloadTable();
/** 载荷 id 白名单（用于手动模式的入参校验与设置页选项）。 */
const PAYLOAD_IDS = ["dsh", "dsh-gen4", "gpt61", "gpt6", "gpt56", "claude", "grok", "glm", "kimi"];
/** 自持族：只有它们走双段注入（主槽位 + 镜像槽位同源逐字一致）。 */
const NATIVE_PAYLOAD_IDS = ["dsh", "dsh-gen4"];
/**
 * 注入段在系统提示里的排序位（`dsh-system-prompt` 按 order 升序全局排序）。
 *
 * **必须落在 (0, 1) 这个夹缝里**，实测的相邻占位：
 *   -1000  `harness:identity`（官方开场白；本插件 patch 已 `includeHarnessIdentity: false` 关掉）
 *       0  `deployment:persona-prefix`（官方构造器注册、**文本被本插件 patch 替换**）
 *       1  `dsh-memory:long-term`（记忆索引，19.5k 字符量级）
 *     100  ← 0.7.0 之前载荷在这里，于是 45% 的记忆整段排在我们的载荷前面
 *    1000+ 官方工具规范；10200 `deployment:persona-suffix`
 *
 * 0.7.1 把载荷提到 persona 之后、记忆之前：用户要的是「我们的提示词在最前面」，
 * 而 persona 段就是本插件自己写的那句（`cordis.patch.yml` 的 personaPrefix）——
 * 所以正确目标是 `identity → persona → 载荷 → 记忆 → 工具规范`，
 * 不能把 order 压到 0 以下（那会变成载荷跑到自己的 persona 前面）。
 * 用小数而非整数：`comparePromptSections` 是纯数值比较，0.1 / 0.2 稳定夹在 0 与 1 之间。
 */
const PRIMARY_SECTION_ORDER = 0.1;
const REINFORCE_SECTION_ORDER = 0.2;
/**
 * 各 id 取不到文本时的回落目标 —— 绝不返回空串（空串是「关闭」语义，
 * 不能与「文件缺失」混淆）。自持档回落到备用自持稿，其余一律回落自持档。
 */
const PAYLOAD_FALLBACKS = {
  dsh: "dsh-gen4",
  "dsh-gen4": "dsh",
  gpt61: "dsh",
  gpt6: "dsh",
  gpt56: "dsh",
  claude: "dsh",
  grok: "dsh",
  glm: "dsh",
  kimi: "dsh",
};
/**
 * GPT 家族判定：**锚定开头**，只认自家命名，不吃 `my-gpt-6-clone` 这类仿冒名。
 * `chat` 前缀也认（`chatgpt-6.1` 是常见产品形态）。
 */
const GPT_FAMILY_RE = /^(?:chat)?gpt|^o\d|^codex|^astra|^luna/;
/**
 * 已知代次的**显式枚举**：多位数（≥2 位数字自成一段）时的还原表。
 * 不用「数值阈值猜拆法」——`major >= 40` 那种判据只在 41/56/61 恰好落窗口时成立，
 * 未来出现真主版本 30-39 或 40+ 就会系统性错判。这里只还原认识的代次，
 * 其余一律当「版本不可解析」交给兜底，判定集合有限且可断言。
 */
const GLUED_VERSIONS = { 35: [3, 5], 41: [4, 1], 56: [5, 6], 61: [6, 1] };
/**
 * 从模型名里抽版本号 —— 容忍真实世界里各种「不太一样」的写法：
 *   `gpt-6.1-sol` / `GPT_6_1_SOL` / `gpt 6.1` / `gpt.6.1.sol` / `gpt6.1sol` /
 *   `chatgpt-6.1` / `gpt61`（粘连） / `gpt-35-turbo`（旧命名，走枚举表）
 * 分隔符允许 `- _ . 空格` 任意组合（0 个或多个）。
 *
 * **小版本的判据是「数字段长度 ≤ 2」而不是「固定 1 位」** —— 这样：
 *   `gpt-5.10`（段长 2）→ 5.10；`gpt-6-0613`（段长 4，是日期戳）→ 只有主版本 6。
 * 负向断言 `(?!\d)` 保证不吃进更长数字段的前缀。
 * @param {string} id 已归一化（小写、无 provider 前缀）的模型名。
 * @returns {{major: number, minor: number}|undefined} 版本号，解析不出时 undefined。
 */
function extractGptVersion(id) {
  const GLUE = "[\\s._-]*";
  const m = new RegExp(`^(?:chat)?gpt${GLUE}(\\d{1,3})(?:${GLUE}(\\d{1,2})(?!\\d))?`).exec(id);
  if (m === null) return undefined;
  const major = Number.parseInt(m[1], 10);
  if (!Number.isFinite(major)) return undefined;
  if (m[2] !== undefined) {
    const minor = Number.parseInt(m[2], 10);
    if (Number.isFinite(minor)) return { major, minor };
  }
  // 无小版本：主版本若是多位数，查枚举表（`gpt-61` 同 `gpt-6.1`）；不在表里就是未知代次
  if (m[1].length >= 2) {
    const known = GLUED_VERSIONS[major];
    return known === undefined ? undefined : { major: known[0], minor: known[1] };
  }
  return { major, minor: 0 };
}

/**
 * 版本号 → 载荷 id。
 *   >6 或 ==6 && minor>=1 → gpt61（6.1 及更新）
 *   ==6                   → gpt6
 *   其余（<=5.x）         → gpt56
 * @param {{major: number, minor: number}} version 版本号。
 * @returns {string} 载荷 id。
 */
function payloadForVersion(version) {
  if (version.major > 6) return "gpt61";
  if (version.major === 6) return version.minor >= 1 ? "gpt61" : "gpt6";
  return "gpt56";
}

/**
 * 判断一个 model id 是否属于 GPT（OpenAI）系 —— 用于「其他 gpt-* 走最近代」的兜底。
 * @param {string} model 模型 id（建议传归一化后的）。
 * @returns {boolean} 是否 GPT 系。
 */
function isGptFamily(model) {
  return GPT_FAMILY_RE.test(String(model ?? ""));
}

/**
 * 归一化模型 id：trim + 转小写 + 剥 provider 前缀 + 剥 `:` 标签后缀。
 *   `  OpenAI/GPT-6.1-SOL  ` → `gpt-6.1-sol`
 *   `deepseek/deepseek-v4-flash:free` → `deepseek-v4-flash`
 * 本机 model 多是裸名，但网关 / 中转 / 各家 SDK 会下发各种组合形态 —— 不归一化
 * 就会一路落到「非 GPT」分支、静默走错载荷。
 * @param {unknown} model 原始模型 id。
 * @returns {string} 归一化后的 id。
 */
function normalizeModelId(model) {
  let id = String(model ?? "").trim().toLowerCase();
  if (id.length === 0) return "";
  // 剥 `:` 标签（openrouter 系 `:free` / `:nitro`）——只剥最后一个标签段
  const colon = id.lastIndexOf(":");
  if (colon > 0 && colon < id.length - 1) id = id.slice(0, colon).trim();
  // 剥 provider 前缀（`vendor/model`）。**尾随斜杠整段丢掉，取斜杠前的有效名**：
  // `gpt-6/` 与 `vendor/gpt-6/` 都应得到 `gpt-6`，而不是空串（空串会退化成 dsh）。
  id = id.replace(/\/+$/, "");
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);
  return id.trim();
}

/**
 * 按模型身份选载荷 id —— **按 model 名解析版本，不按 provider**。
 * 理由（本机实测）：`gpt-6.1-sol` 同时挂在 `gpt` 与 `heihei` 两个 provider 下，
 * 只看 provider 必然漏掉后者。
 *
 * 解析顺序（容忍各种「不太一样」的写法，不靠规则表顺序）：
 *   ① 归一化 → ② 抽版本号 → ③ 版本 → 载荷
 *   ④ 版本抽不出但确属 GPT 系 → 按家族特征兜底
 *   ⑤ 非 GPT 系 → DSH 自持载荷
 * @param {string|undefined} model 当前模型 id（agent.options.model）。
 * @returns {string} 载荷 id。
 */
function matchPayloadId(model) {
  const id = normalizeModelId(model);
  if (id.length === 0) return "dsh";
  const version = extractGptVersion(id);
  if (version !== undefined) return payloadForVersion(version);
  // ── 归一化后仍带 provider 前缀的家族（claude / grok / glm / kimi）──────────
  // 锚定开头，与 GPT 家族同一套做法（`GPT_FAMILY_RE` 同样是 `^` 锚定，不吃
  // `my-gpt-6-clone` 这类仿冒名）。归一化已剥掉 `vendor/`，所以
  // `anthropic/claude-opus-5-5` 与 `claude-opus-5-5` 在这里走同一条路。
  if (/^claude/.test(id)) return "claude";
  if (/^grok/.test(id)) return "grok";
  // glm 家族（glm-5.3-flash / glm-5.3-flashx / glm-4* / chatglm*）：ZCode 载荷
  // 本就是为 GLM 写的（zcode-keysmith 面向 ZCode，即 GLM 的 CLI）。
  if (/^(?:glm|chatglm)/.test(id)) return "glm";
  // kimi 家族（kimi-k2* / kimi-k3* / moonshot 代理剥前缀后同形）。
  // `swe` 系（swe-1 / swe-2…）同属 Kimi 系 —— 用户 2026-10-13 指定，裸名（`swe-2`，
  // 无 kimi 前缀）也归这里。`swe` 后必须跟数字/下划线/连字符：`swe[\d_-]` 让
  // `sweet-*` 这类前缀撞名天然排除（裸 `swe` 也不吃）。
  if (/^(?:kimi|swe[\d_-])/.test(id)) return "kimi";
  // ── 版本不可解析：先判家族，再按家族特征保守兜底 ────────────────────────
  if (!isGptFamily(id)) return "dsh";
  // o 系 / codex 系历史上是 5.x 一脉
  if (/^(?:o\d|codex)/.test(id)) return "gpt56";
  if (/^astra/.test(id)) return "gpt6";
  if (/^luna/.test(id)) return "gpt61";
  // 其余 gpt* 解析不出代次：**保守取最近代**（gpt61）而不是旧代 ——
  // 新模型用旧载荷会失效，旧模型用新载荷最多是措辞不完全贴合；
  // 二者不对称，故选「宁可新，不可旧」。
  return "gpt61";
}

// 双段注入镜像开关：
//   true  = 沿用四代双层架构，主槽位与镜像槽位各注入一份同源载荷（重复注入）
//   false = 单段注入（只留主槽位），省掉重复 token，行为等价
// 2026-10-05：置 true —— 按用户要求恢复双段（两文件逐字同源，效果 = 同一份载荷注入两遍）。
const DUAL_LAYER_INJECTION = true;

const VERSION = "0.10.0";
// 版本锚点（校验脚本按字面量断言，须与 package.json 的 version 同步）：
//   pluginVersion: "0.10.0"

// 开关落点：profile entry config（cordis.patch.yml → dsh-switch-armor.config.enabled）；
// 0.2.x 由 settings 表单面写回：客户端开关 → ctx.remote.settings.mutate(ns, ops, revision)。
const SETTINGS_NAMESPACE = "dsh-switch-armor";
const SETTINGS_FIELD = "enabled";
const MODE_FIELD = "mode";
const MANUAL_PAYLOAD_FIELD = "manualPayload";
// 按模型族覆盖 + 自定义载荷（0.10.0）
const MODEL_OVERRIDES_FIELD = "modelOverrides";
const CUSTOM_PAYLOAD_FIELD = "customPayload";
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
  Schema.boolean().default(DEFAULT_ENABLED).description("Switch Armor提示词注入总开关（默认关）");
const modeField = () =>
  Schema.union(["auto", "manual"])
    .default(DEFAULT_MODE)
    .description("载荷路由模式：auto = 按当前模型自动选，manual = 固定用手动指定的载荷");
const manualPayloadField = () =>
  Schema.union(PAYLOAD_IDS)
    .default(DEFAULT_MANUAL_PAYLOAD)
    .description("手动模式下固定使用的载荷（mode=manual 时生效）");
// ── 按模型族覆盖（0.10.0）─────────────────────────────────────────────────────
// 载荷 id 白名单 + "custom"（自定义载荷，文本存 customPayload.text）。
// 族 id 全集 = matchPayloadId 的全部返回值（dsh/dsh-gen4/gpt61/gpt6/gpt56/claude/
// grok/glm/kimi），实测全部匹配 /^[a-z0-9_-]{1,32}$/ —— 该正则即覆盖键的合法形状。
const OVERRIDE_PAYLOAD_IDS = [...PAYLOAD_IDS, "custom"];
const CUSTOM_PAYLOAD_MAX_CHARS = 64 * 1024; // 按字符计（UTF-8 下中文最多 ×3 字节，64k 字符约 192KB）
/** 覆盖表清洗：只做形状校验，合法条目保留、非法条目丢弃；**不写回** settings（读取时过滤，
 * 用户原始数据不动，日后族名/形状调整也不可逆地毁数据）。 */
function sanitizeModelOverrides(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const [family, entry] of Object.entries(raw)) {
    if (!/^[a-z0-9_-]{1,32}$/.test(family) || entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const out = {};
    if (typeof entry.payload === "string" && OVERRIDE_PAYLOAD_IDS.includes(entry.payload)) out.payload = entry.payload;
    if (typeof entry.dualLayer === "boolean") out.dualLayer = entry.dualLayer;
    if (Object.keys(out).length > 0) result[family] = out;
  }
  return result;
}
/** 自定义载荷清洗：只认 { text: string }，超限截断到上限（截断而非丢弃 —— 大文本粘贴
 * 超限时报错代价高于截断，且截断点对用户可见可再编辑）。 */
function sanitizeCustomPayload(raw) {
  const text = raw !== null && typeof raw === "object" && !Array.isArray(raw) && typeof raw.text === "string" ? raw.text : "";
  return { text: text.length > CUSTOM_PAYLOAD_MAX_CHARS ? text.slice(0, CUSTOM_PAYLOAD_MAX_CHARS) : text };
}
const modelOverridesField = () =>
  Schema.dict(Schema.string(), Schema.any()).default({}).description("按模型族覆盖载荷与双段注入：{ glm: { payload: 'dsh-gen4', dualLayer: true }, … }，payload 可为载荷 id 或 'custom'（读取时经 sanitizeModelOverrides 过滤）");
const customPayloadField = () =>
  Schema.dict(Schema.string(), Schema.any()).default({}).description("自定义载荷：{ text }，任何模型族可通过 override 的 payload='custom' 选用，上限 64k 字符（经 sanitizeCustomPayload 过滤）");
const SettingsSchema = Schema.object({
  enabled: enabledField(),
  mode: modeField(),
  manualPayload: manualPayloadField(),
  modelOverrides: modelOverridesField(),
  customPayload: customPayloadField(),
}).description("Switch Armor / dsh-switch-armor 运行时开关");
/** 0.2.x settings 表单面 schema：entry id = 插件 id，字段必须 volatile 才能在线编辑。 */
export const Config = Schema.object({
  enabled: enabledField().volatile(),
  mode: modeField().volatile(),
  manualPayload: manualPayloadField().volatile(),
  modelOverrides: modelOverridesField().volatile(),
  customPayload: customPayloadField().volatile(),
});

// ── 会话级开关覆盖 ──────────────────────────────────────────────────────────────
// 全局默认 = profile entry config 的 enabled（新会话继承它）；单个会话可在状态条开关上
// 单独覆盖，存插件自持文件（与记忆插件同款做法，与宿主版本无关，改完立即生效）。
const SESSION_STORE = join(homedir(), ".dsh", "switch-armor", "sessions.json");

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
// 默认模型服务句柄：自动分流在「会话还没写过 request/header」时用它拿当前默认模型。
// 它是可选依赖 —— 服务缺席时 modelOf 继续向下回落到 agent.options，不影响其余功能。
let agentDefaultModelService;
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
    // 按模型族覆盖（0.10.0）：形状不合法的条目在清洗时丢弃，合法的原样可用
    modelOverrides: sanitizeModelOverrides(resolveField(resolved, runtimeOverride, MODEL_OVERRIDES_FIELD)),
    // 自定义载荷（0.10.0）：{ text }，非法形状归零文本
    customPayload: sanitizeCustomPayload(resolveField(resolved, runtimeOverride, CUSTOM_PAYLOAD_FIELD)),
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
const ROUTE_HEADER = "x-dsh-switch-armor";

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
 * 开关的自有读写路由（webServer 前缀 /dsh-switch-armor）：
 *   GET  /dsh-switch-armor/settings            → { ok, enabled, source }
 *   POST /dsh-switch-armor/settings {enabled}  → 先试 settings.update 持久化，写不动则内存覆盖
 * 注意 prefix 路由下 req.url 是完整路径，判定必须按完整路径收。
 * @param {import("node:http").IncomingMessage} req 请求。
 * @param {import("node:http").ServerResponse} res 响应。
 */
async function handleSettingsRoute(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "");
  const isSettings = path === "/dsh-switch-armor/settings" || path.endsWith("/settings");
  const isSession = path === "/dsh-switch-armor/session" || path.endsWith("/session");
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
        // 按模型族覆盖 + 自定义载荷（0.10.0）
        modelOverrides: state.modelOverrides,
        customPayload: state.customPayload,
        overridePayloadIds: OVERRIDE_PAYLOAD_IDS,
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
  if (body.modelOverrides !== undefined) {
    // 覆盖表：清洗后写回（清洗丢弃形状非法条目；合法条目含 payload/dualLayer 任一）
    patch[MODEL_OVERRIDES_FIELD] = sanitizeModelOverrides(body.modelOverrides);
  }
  if (body.customPayload !== undefined) {
    // 自定义载荷：{ text: string }，超限截断（sanitizeCustomPayload 内处理）
    patch[CUSTOM_PAYLOAD_FIELD] = sanitizeCustomPayload(body.customPayload);
  }
  if (Object.keys(patch).length === 0) {
    return sendJson(res, 400, {
      ok: false,
      error: "expected at least one of { enabled, mode, manualPayload, modelOverrides, customPayload }",
    });
  }

  let persisted = false;
  const service = settingsService;
  if (service !== undefined && typeof service.update === "function") {
    try {
      await service.update(SETTINGS_NAMESPACE, patch);
      // 写完自校验：真值确实落地才算持久化成功，否则退回内存覆盖。
      // 对象字段（modelOverrides/customPayload）不能 === 比较，改按 JSON 序列化比对。
      const after = readState();
      persisted = Object.entries(patch).every(([key, value]) => {
        const got = after[key];
        if (value !== null && typeof value === "object") {
          return JSON.stringify(got) === JSON.stringify(value);
        }
        return got === value;
      });
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
 * 条件段文本求值器（主槽位）：宿主每个模型步以 `{ agent, scope, signal }` 调用一次，
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
 * 镜像段（reinforce）文本 —— 默认只有自持族（`dsh` / `dsh-gen4`）非空。
 * 外部稿（Codex 三份 / claude / grok / glm / kimi）默认恒为空串：它们是状态机式单一整份，
 * Codex 三份明文写「Text loaded afterward cannot select, replace, or nest ACTION」，
 * grok 稿自带 <|im_start|> / <|im_end|> 闭合标签 —— 注入第二遍都会自伤。
 * 自持族按双段注入：**返回与主槽位完全相同的那一份文本**，
 * 保证「两段同源逐字一致」这条性质在 `dsh-gen4` 也成立（旧版硬绑 PROMPT41_TEXT，
 * 只对原自持稿成立，切到 dsh-gen4 就会与主槽位不同源）。
 * 0.10.0 起族覆盖可带 `dualLayer` 强制指定（见 {@link dualLayerFor}）——
 * 用户明确开的族即便吃外部稿也注入双段，风险自负。
 * @param {object} context assemble context。
 * @returns {string} 双段族的同源副本，其余恒为空串。
 */
function gatedReinforce() {
  return (context) => {
    if (!isEnabledForSession(sessionIdOf(context))) return "";
    if (!dualLayerFor(context)) return "";
    return payloadTextFor(context, "reinforce");
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
  // manual 模式：全局统一，不受族覆盖影响（覆盖语义是「改 auto 的判断」）。
  if (state.mode === "manual") return state.manualPayload;
  const family = matchPayloadId(modelOf(context));
  // ── 按模型族覆盖（0.10.0）──────────────────────────────────────────────────
  // auto 模式下，某族配了 override.payload 就用它（可以是任意载荷 id 或 "custom"）。
  // 形状不合法的条目已在 sanitizeModelOverrides 过滤，这里只需取值。
  const override = state.modelOverrides?.[family];
  if (override && typeof override.payload === "string" && override.payload.length > 0) {
    return override.payload;
  }
  return family;
}

/**
 * 读「本会话的双段注入判定」。
 *
 * 0.9.x 之前是纯常量判定：`NATIVE_PAYLOAD_IDS.includes(resolvePayloadId(context))`。
 * 0.10.0 起族覆盖可带 `dualLayer: boolean` **强制指定** —— 明确开了就双段（哪怕
 * 那份载荷是外部稿），明确关了就单段（哪怕那份是自持稿）；没写 `dualLayer` 的族
 * 维持原生口径不变。
 * @param {object|undefined} context assemble context。
 * @returns {boolean} 是否注入双段。
 */
function dualLayerFor(context) {
  const state = readState();
  const id = resolvePayloadId(context);
  if (state.mode !== "manual") {
    const family = matchPayloadId(modelOf(context));
    const override = state.modelOverrides?.[family];
    if (override && typeof override.dualLayer === "boolean") return override.dualLayer;
  }
  return NATIVE_PAYLOAD_IDS.includes(id);
}

/**
 * 从 section 求值 context 里取「本会话当前实际使用的模型 id」。
 *
 * **取值链（顺序不可颠倒）**：
 *   ① `agent.session.requestHeader().config.model` —— 会话**实际发出**的请求头。
 *      这是唯一能反映「会话内切换过模型」的来源。
 *   ② `agent.options.model` —— agent 创建时的声明路由（**可能是默认模型，不是会话选择**）。
 *
 * 为什么必须优先 ①：`agent.options` 在 `new Agent(...)` 时由
 * `sessionController.agentOptions()` → `agentDefaultModel.currentSelection()` 固定
 * （`AgentOptions` 的 options 是 readonly），而会话内切换模型写的是 `model/selection`
 * 事件 + `session.requestHeader()`。本机 `agent-default-model` = `qoder/dfmodel`，
 * 而会话选的是 `openai-codex/gpt-6.1-sol` —— 只读 ② 会把 GPT 会话误判成非 GPT 模型，
 * 这正是「auto 模式不分流」的根因（manual 模式绕过判定所以正常）。
 *
 * 官方对照：`packages/api/session-controller/src/agent.ts` 的 `selectionFor(agent).current`
 * 用的就是「pending 选择 → requestHeader().config → defaultModel」这条链。
 * agent 是宿主内部对象，全程 try 包裹，取不到就回落 DSH 自持载荷。
 * @param {object|undefined} context assemble context。
 * @returns {string|undefined} 模型 id。
 */
function modelOf(context) {
  try {
    const agent = context?.agent;
    // ① 会话实际请求头（反映会话内切换后的真实模型）—— 最可靠
    const logged = agent?.session?.requestHeader?.();
    const loggedModel = logged?.config?.model;
    if (typeof loggedModel === "string" && loggedModel.length > 0) return loggedModel;
    // ② 当前默认模型。**首步（本会话还没写过 request/header）时必须走这层**：
    //    `agent.options.model` 是 agent 创建那一刻冻结的值，若那之后用户切过默认模型，
    //    它会停在一个陈旧名字上 —— 实测踩过：某会话首步据此判成 GPT、次步才纠正为 DSH。
    //    官方 `selectionFor(agent).current` 的第三级也是 defaultModel，而不是 agent.options。
    const picked = currentDefaultModelOf(agent);
    if (typeof picked === "string" && picked.length > 0) return picked;
    // ③ agent 创建时声明的路由（最终兜底）
    const declared = agent?.options?.model;
    if (typeof declared === "string" && declared.length > 0) return declared;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读「当前默认模型」——`agentDefaultModel.currentSelection().model`。
 * 服务缺席（未挂载 / 尚未回调）时返回 undefined，由调用方继续向下回落。
 * @param {object|undefined} agent host agent 对象（仅用于兜底取值，实际不依赖它）。
 * @returns {string|undefined} 当前默认模型 id。
 */
function currentDefaultModelOf(agent) {
  try {
    const service = agentDefaultModelService;
    if (service !== undefined && typeof service.currentSelection === "function") {
      const picked = service.currentSelection();
      const model = picked?.model;
      if (typeof model === "string" && model.length > 0) return model;
    }
  } catch {
    /* 服务在卸载窗口可能抛错：静默回落 */
  }
  return undefined;
}

/**
 * 取本会话当前实际使用的 provider（与 {@link modelOf} 同一条取值链，仅用于诊断展示）。
 * @param {object|undefined} context assemble context。
 * @returns {string|undefined} provider 名。
 */
function providerOf(context) {
  try {
    const agent = context?.agent;
    const logged = agent?.session?.requestHeader?.();
    const loggedProvider = logged?.config?.provider;
    if (typeof loggedProvider === "string" && loggedProvider.length > 0) return loggedProvider;
    try {
      const picked = agentDefaultModelService?.currentSelection?.();
      if (typeof picked?.provider === "string" && picked.provider.length > 0) return picked.provider;
    } catch {
      /* 同上 */
    }
    const declared = agent?.options?.provider;
    if (typeof declared === "string" && declared.length > 0) return declared;
    return undefined;
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
  // ── 自定义载荷（0.10.0）────────────────────────────────────────────────────
  // id = "custom" 时文本来自 settings 的 customPayload.text（用户在设置页输入框粘贴）。
  // 空文本视为「未配置」→ 走回落链，与文件缺失同语义（绝不静默注入空串）。
  if (id === "custom") {
    const custom = sanitizeCustomPayload(readState().customPayload);
    if (custom.text.length > 0) return custom.text;
    // 空文本 = 未配置 → 回落自持档 dsh（显式写死，不走 PAYLOAD_FALLBACKS ——
    // 那张表里 dsh 自己的回落目标是 dsh-gen4，会绕开用户预期的「默认档」）。
    const customFallback = PAYLOADS.dsh?.text;
    if (typeof customFallback === "string" && customFallback.length > 0) return customFallback;
    return PROMPT_TEXT;
  }
  const entry = PAYLOADS[id];
  const text = entry?.text ?? "";
  if (text.length > 0) return text;
  // 文件缺失等异常一律**按 id 回落**，绝不返回空串
  // （空串是「关掉」的语义，不能与「取不到」混淆）。
  // 0.7.0 前的旧实现硬绑 PROMPT_TEXT（原自持稿）—— 在 7 份载荷的表下，
  // 那会让「claude 文件缺失」静默注入一份自持稿，属错误载荷而非降级。
  const fallbackId = PAYLOAD_FALLBACKS[id];
  const fallback = fallbackId === undefined ? undefined : PAYLOADS[fallbackId]?.text;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return PROMPT_TEXT;
}

const objectOutput = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
};

// 运行时元数据工具：返回插件版本与能力清单
const profileTool = {
  name: "switch_armor_profile",
  description:
    "Return runtime metadata for the bundled Switch Armor 破甲系统提示词与版本元数据。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  output: objectOutput,
  execute() {
    const enabled = isEnabled();
    const state = readState();
    return {
      plugin: "dsh-switch-armor",
      pluginVersion: VERSION,
      pluginDisplayName: "Switch Armor",
      name: "switch-armor",
      displayName: "Switch Armor",
      kernelVersion: VERSION,
      targetArchitecture: "DeepSeek-V4 / V4-Pro / V4.1-Flash 全系列",
      baseline: "deepseek-unrestricted-v7-stable (dsh-switch-armor)",
      promptSource: [
        "prompts/infinite-gen-4.md",
        "prompts/infinite-gen-4.1-flash.md",
        "prompts/gpt-6.1-sol.md",
        "prompts/gpt-6-astra.md",
        "prompts/gpt-5.6-sol.md",
      ],
      lineage: [`dsh-switch-armor (v${VERSION}) — 按模型分流注入载荷 + 对话框热开关 + 按模型族覆盖`],
      // 总开关状态：enabled=false 时所有载荷均渲染为空串，系统提示词零残留
      enabled,
      // 载荷路由：auto = 按当前模型身份选（族覆盖可改判）；manual = 固定用手动指定那份
      payloadRouting: {
        mode: state.mode,
        manualPayload: state.manualPayload,
        payloads: PAYLOAD_IDS.map((pid) => ({ id: pid, label: PAYLOADS[pid]?.label ?? pid })),
        // 按模型族覆盖（0.10.0）：{ family: { payload, dualLayer } }，payload 可为 "custom"
        modelOverrides: state.modelOverrides,
        customPayloadChars: state.customPayload.text.length,
        rules: "gpt-6.1→gpt61 / gpt-6→gpt6 / gpt-5.6|gpt-5|o<n>|codex→gpt56 / 非 GPT→dsh（未列代次按最大版本号兜底）",
      },
      control: {
        kind: "dialog-switch",
        settingsNamespace: SETTINGS_NAMESPACE,
        settingsField: SETTINGS_FIELD,
        settingsFields: [SETTINGS_FIELD, MODE_FIELD, MANUAL_PAYLOAD_FIELD],
        persistence: "profile patch → dsh-switch-armor.config.*（0.2.x 由 settings 表单面 settings.mutate 写回；0.1.7 前为 ~/.dsh/settings.yaml）",
        fallbackWhenSettingsMissing: fallbackEnabled,
      },
      injection: [
        {
          section: "switch-armor:global-system-prompt",
          order: PRIMARY_SECTION_ORDER,
          enabled,
          payload: state.mode === "manual" ? state.manualPayload : "(auto: 按模型)",
        },
        {
          section: "switch-armor:dual-layer-reinforce",
          order: REINFORCE_SECTION_ORDER,
          // GPT 系走单段（载荷自带 ACTION 绑定规则，重复注入会自我冲突）
          enabled: enabled && DUAL_LAYER_INJECTION,
          note: "仅自持族（dsh / dsh-gen4）非空；外部载荷恒为空串（单段）",
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
        "Session Switch: 开关按会话生效 —— section 求值 context 带 { agent, scope, signal }，用 agent.sessionId / session.header.id 查 ~/.dsh/switch-armor/sessions.json 覆盖；⌥ 点击切全局",
        "Dialog Switch: 输入框状态条内联开关，经自有路由（host 先试 settings.update 持久化）写开关，下一模型步即时生效",
        "Settings Form: 导出 volatile Config + settings.configure，官方设置页与客户端开关共用同一写入面（写盘落点 = profile patch）",
        "Conditional Sections: 关闭时 section.text 求值为空串，renderPrompt 过滤，零残留",
        "Single-Layer Injection: 自持族之外的载荷单段注入",
        "Section Hosting: 主槽位 order " + PRIMARY_SECTION_ORDER + " / 镜像槽位 order " + REINFORCE_SECTION_ORDER + "，由 DUAL_LAYER_INJECTION 切换镜像段",
        "Armor Projection: 开头窗口(160)判拒 + REFUSAL/FALLBACK/SAFE/RISK 标记 + 域命中",
        "Client Badge: 输入框上方「Switch Armor」实时状态条（含开关）",
        "Profile Tool: switch_armor_profile 返回内核版本、开关状态与注入槽位元数据",
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
// 2026-10-08 规则表单源化：本文件不再维护第二份规则表。历史上两份副本曾双向
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
    return {
      ...state,
      running: true,
      verdict: null,
      words: [],
      safe: [],
      risk: [],
      domain: null,
      domainHits: 0,
      // 新一轮开始：清掉上一轮的锚点（refusalSeq 保留到下次判定，便于观测最近一次拒绝）
      turnSeq: null,
      delivered: false,
    };
  }
  // 锚点：只认真实用户输入（source.kind === "user"）。agent-instructions 的基线/刷新
  // 消息、runtime-context 等同样是 user/message 事件，不能当成回合起点，否则将来
  // 回滚会指向错误的位置。这里只记录，不触发任何动作（干跑阶段）。
  if (event.type === "user/message" && event?.data?.source?.kind === "user") {
    return {
      ...state,
      turnSeq: typeof event.seq === "number" ? event.seq : null,
      refusalSeq: null,
      verdict: null,
      delivered: false,
    };
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
      delivered: scored.delivered === true,
      // 判为拒绝时记下本条序号：将来「改写重试」要 rewind 到 turnSeq（inclusive）
      // 再把改写版重发；此处仅记录，不做任何回滚/重发。
      refusalSeq: scored.verdict === "refusal" && typeof event.seq === "number" ? event.seq : null,
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
/** 载荷文本取值（供探针断言「按 id 回落」与「双段同源」）。 */
export const __testPayloadTextFor = payloadTextFor;
/** 载荷表快照（只读用途：探针比对文件字节与表内文本是否一致）。 */
export const __testPayloads = PAYLOADS;
// ── 0.10.0 按模型族覆盖 + 自定义载荷 ─────────────────────────────────────────
export const __testOverridePayloadIds = OVERRIDE_PAYLOAD_IDS;
export const __testDualLayerFor = dualLayerFor;
export const __testSanitizeModelOverrides = sanitizeModelOverrides;
export const __testSanitizeCustomPayload = sanitizeCustomPayload;
export const __testCustomPayloadMaxChars = CUSTOM_PAYLOAD_MAX_CHARS;
/** 探针写状态用：把 override 表注入 runtimeOverride（与真实 settings 写入同一通道）。 */
export function __testSetRuntimeOverride(patch) {
  runtimeOverride = { ...(runtimeOverride ?? {}), ...patch };
}
export function __testClearRuntimeOverride() {
  runtimeOverride = undefined;
}

export const name = "dsh-switch-armor";
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
        `switch-armor: settings namespace ${SETTINGS_NAMESPACE}`,
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
        `switch-armor: settings form ${SETTINGS_NAMESPACE}`,
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
          path: "/dsh-switch-armor",
          handler: handleSettingsRoute,
        }),
      "switch-armor: settings route",
    );
  });

  // ── 0.6 默认模型服务（可选依赖）──────────────────────────────────────────────
  // 自动分流在「本会话还没写过 request/header」的首步需要它：agent.options.model 是
  // agent 创建时冻结的值，可能停在用户切走前的旧模型上（实测踩过首步错配）。
  // 服务缺席只是少一层兜底，不影响其余功能 —— 所以单列一个 inject，不并进模块级 inject。
  if (typeof ctx.inject === "function") {
    ctx.inject(["agentDefaultModel"], (mctx) => {
      agentDefaultModelService = mctx.agentDefaultModel;
    });
  }

  // ── 1. 条件提示词段：开关关闭时渲染为空串（renderPrompt 过滤，零残留） ────────
  // 载荷按「手动指定 / 当前模型身份」动态选择：GPT 系走 Codex 载荷，其余走 DSH 自持载荷。
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: "switch-armor:global-system-prompt",
      order: PRIMARY_SECTION_ORDER,
      text: gated(),
    }),
  );
  if (DUAL_LAYER_INJECTION) {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: "switch-armor:dual-layer-reinforce",
        order: REINFORCE_SECTION_ORDER,
        // 自持族双段（刻意权重强化）；外部载荷单段（见 gatedReinforce 注释）
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
    // 5：新增 turnSeq / refusalSeq —— 回滚锚点（干跑阶段只记录，不触发任何动作）
    stateVersion: 5,
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
      // ── 回滚锚点（干跑，仅供观测与将来的按钮使用）──────────────────────
      // turnSeq：本轮那条用户消息的事件序号；refusalSeq：判为拒绝的助手回复序号。
      // 将来「改写重试」要 rewind 到 turnSeq（inclusive，连该轮一起撤掉）再重发。
      turnSeq: null,
      refusalSeq: null,
      delivered: false,
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
      ctx.effect(() => p.register(armorDef, "switch-armor: armor projection"));
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
