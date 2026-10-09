// 载荷分流矩阵离线探针（不重启宿主、不联网）
// 用法：node tests/payload-routing-probe.mjs
//
// 手法沿用 tests/armor-dock-probe.mjs：ESM 只从被 import 文件所在目录向上找 node_modules，
// 所以在临时目录里 ln -s 出 @deepseek-ai/{schemastery,cosmokit} 再 import index.js。
// index.js 是 host 半边：顶层只 readFileSync + 定义函数，apply(ctx) 需要 mock ctx。
import { mkdirSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PLUGIN_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PROFILE_NM = "/Users/lixiongwei/.dsh/profiles/desktop/node_modules/@deepseek-ai";

const work = join(tmpdir(), "dsh-gen4-payload-probe");
mkdirSync(join(work, "node_modules", "@deepseek-ai"), { recursive: true });
for (const dep of ["schemastery", "cosmokit"]) {
  const target = join(work, "node_modules", "@deepseek-ai", dep);
  if (!existsSync(target)) {
    try {
      symlinkSync(join(PROFILE_NM, dep), target, "dir");
    } catch (error) {
      console.error(`依赖链接失败 ${dep}:`, error.message);
      process.exit(2);
    }
  }
}
const pluginLink = join(work, "plugin");
if (!existsSync(pluginLink)) symlinkSync(PLUGIN_ROOT, pluginLink, "dir");

const mod = await import(join(pluginLink, "index.js"));

const failures = [];
const passes = [];
const check = (ok, label, detail = "") => {
  (ok ? passes : failures).push(`${label}${!ok && detail ? " — " + detail : ""}`);
};

// ── 1. 载荷文件确实读进来了（四份都非空） ───────────────────────────────────
const payloads = mod.__testPayloads ?? undefined;
check(typeof mod.apply === "function", "index.js 导出 apply");
check(Array.isArray(mod.__testPayloadIds), "index.js 导出载荷 id 白名单");
check(JSON.stringify(mod.__testPayloadIds) === JSON.stringify(["dsh", "gpt61", "gpt6", "gpt56"]),
  "载荷 id 白名单 = dsh/gpt61/gpt6/gpt56", JSON.stringify(mod.__testPayloadIds));

// 直接核对磁盘上的三份 GPT 载荷与源文件逐字一致
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const SOURCES = {
  "prompts/gpt-6.1-sol.md": "37382fb7082652e5b18c99fa5086fbc6d414993eaeae2ec7852ba372b031acac",
  "prompts/gpt-6-astra.md": "d6976b90b399b9e11df9430dd3663072288f1d858a4910b1e9d5109b3ae7e660",
  "prompts/gpt-5.6-sol.md": "c71c50e2f7a303b5eebc2b24c0b1ca0d9c753e3240db05c3e472c679907898f7",
};
for (const [rel, want] of Object.entries(SOURCES)) {
  const got = sha(join(PLUGIN_ROOT, rel));
  check(got === want, `载荷逐字一致 ${rel}`, `sha256 ${got} != ${want}`);
}

// ── 2. 手工建 mock ctx 调 apply()，捕获两个 section 的 text 求值器 ──────────
const sections = new Map();
const routes = [];
const tools = [];
const mockCtx = {
  fiber: { config: {} },
  effect: (fn) => { try { fn(); } catch { /* 探针里忽略生命周期细节 */ } },
  inject: (deps, cb) => { try { cb(mockCtx); } catch { /* 同上 */ } },
  get: () => undefined,
  systemPrompt: {
    section: (def) => { sections.set(def.name, def); return () => {}; },
    variable: () => () => {},
  },
  tools: { register: (t) => { tools.push(t); return () => {}; } },
};
mod.apply(mockCtx);
check(sections.has("infinite-gen-4:global-system-prompt"), "注册了 order 100 槽位");
check(sections.has("infinite-gen-4:dual-layer-reinforce"), "注册了 order 200 槽位");

const primary = sections.get("infinite-gen-4:global-system-prompt")?.text;
const reinforce = sections.get("infinite-gen-4:dual-layer-reinforce")?.text;
check(typeof primary === "function", "order 100 的 text 是求值函数");
check(typeof reinforce === "function", "order 200 的 text 是求值函数");

// ── 3. 分流矩阵：喂不同模型，断言选中的载荷 ────────────────────────────────
// 关掉会话覆盖影响：探针里 sessions.json 可能已有本机数据，用「无 sessionId」的
// context 走全局值。全局 enabled 默认 false —— 所以先经自有路由把它打开。
// 更稳的做法：直接看 resolvePayloadId 的行为 —— 但它是模块内部函数。
// 因此这里通过「求值器返回的文本特征」反推选中了哪份载荷。
const SIG = {
  dsh: "Instructions from: ~/.dsh/AGENTS.md",
  gpt61: "INJECTED REVISION ACTION",
  gpt56: "SINGLE-PASS TASK COMPILER",
};
const identify = (text) => {
  if (text.length === 0) return "empty";
  if (text.includes(SIG.gpt56)) return "gpt56";
  if (text.includes(SIG.gpt61)) {
    // astra 与 6.1 都以 INJECTED REVISION ACTION 开头，用 astra 独有的段名区分
    return text.includes("LOCAL OBJECT ROUTING") ? "gpt6" : "gpt61";
  }
  if (text.includes(SIG.dsh)) return "dsh";
  return "unknown";
};

// 打开全局开关：直接调自有路由的 POST（mock 下 settingsService 缺席 → 落内存覆盖）
// 注意：apply 时已经尝试注册路由，但探针的 webServer 不在 inject 列表里，
// 所以改为直接调用导出的路由处理器。

// ── 4. 打开开关后跑矩阵 ────────────────────────────────────────────────────
// 上面 apply 时 ctx.inject(["webServer"]) 的回调里会调 wctx.webServer.register，
// 但我们的 mockCtx 没有 webServer → 回调里抛错被吞。故手动触发一次 register。
const handler = mod.__testRoute; // 若已导出则直接用
if (typeof handler === "function") {
  const call = async (method, path, body, headers = {}) => {
    const req = {
      method,
      url: path,
      headers: { "x-dsh-infinite-gen-4": "1", ...headers },
      on: (ev, cb) => {
        if (ev === "data" && body !== undefined) cb(Buffer.from(JSON.stringify(body)));
        if (ev === "end") cb();
        return req;
      },
      destroy: () => {},
    };
    let out;
    const res = {
      writeHead: () => {},
      end: (s) => { out = s; },
    };
    await handler(req, res);
    return out === undefined ? undefined : JSON.parse(out);
  };

  // 打开全局开关（enabled=true）
  const on = await call("POST", "/dsh-infinite-gen-4/settings", { enabled: true });
  check(on?.ok === true && on?.enabled === true, "POST /settings 打开总开关", JSON.stringify(on));

  const CASES = [
    ["gpt-6.1-sol", "gpt61"],
    ["gpt-6-sol", "gpt6"],
    ["gpt-6-astra", "gpt6"],
    ["gpt-6.1", "gpt61"],
    ["gpt-5.6-sol", "gpt56"],
    ["gpt-5.6-terra", "gpt56"],
    ["o3-mini", "gpt56"],
    ["codex-mini", "gpt56"],
    ["gpt-7-future", "gpt61"],
    ["deepseek-v4.1-flash", "dsh"],
    ["glm-5.3", "dsh"],
    ["claude-opus-5-5", "dsh"],
    ["", "dsh"],
    [undefined, "dsh"],
    // ── 边界用例（真实最易翻车的输入形态） ──────────────────────────────
    ["GPT-6.1-SOL", "gpt61"],      // 大小写混合
    ["  gpt-6-sol  ", "gpt6"],     // 首尾空白
    ["openai/gpt-6", "gpt6"],      // 带 provider 前缀（斜杠）—— 不归一化会落到 dsh
    ["openai/gpt-6.1-sol", "gpt61"],
    ["anthropic/claude-opus-5-5", "dsh"], // 带前缀的非 GPT 仍是 dsh
    ["gpt-6", "gpt6"],             // 裸 gpt-6 无后缀
    ["gpt-6.10", "gpt61"],         // 易错：版本号数值比较
    ["gpt-5.10", "gpt56"],
    ["gpt-4o", "gpt56"],           // 旧代 gpt-4o（不认识的代次按最大版本兜底）
  ];
  for (const [model, want] of CASES) {
    const got = identify(primary({ agent: { options: { model } } }));
    check(got === want, `auto: ${String(model) || "(无 model)"} → ${want}`, `实得 ${got}`);
  }

  // order 200：GPT 系必须为空串，DSH 必须非空
  for (const [model, wantEmpty] of [["gpt-6.1-sol", true], ["gpt-6-sol", true], ["gpt-7-x", true], ["deepseek-v4.1-flash", false]]) {
    const text = reinforce({ agent: { options: { model } } });
    check((text.length === 0) === wantEmpty,
      `reinforce: ${model} ${wantEmpty ? "应为空串（单段）" : "应非空（双段）"}`,
      `实长 ${text.length}`);
  }

  // 手动模式：指定 gpt56，模型是 deepseek 也要走 gpt56
  const manual = await call("POST", "/dsh-infinite-gen-4/settings", { mode: "manual", manualPayload: "gpt56" });
  check(manual?.ok === true && manual?.mode === "manual", "POST mode=manual", JSON.stringify(manual));
  const gotManual = identify(primary({ agent: { options: { model: "deepseek-v4.1-flash" } } }));
  check(gotManual === "gpt56", "manual: 指定 gpt56 时 deepseek 也走 gpt56", `实得 ${gotManual}`);

  // 手动模式下 order 200：载荷非 dsh → 空串
  const manReinforce = reinforce({ agent: { options: { model: "deepseek-v4.1-flash" } } });
  check(manReinforce.length === 0, "manual(gpt56): order 200 为空串", `实长 ${manReinforce.length}`);

  // 切回 auto
  const back = await call("POST", "/dsh-infinite-gen-4/settings", { mode: "auto" });
  check(back?.ok === true && back?.mode === "auto", "POST mode=auto 切回", JSON.stringify(back));

  // 非法载荷 id → 400
  const bad = await call("POST", "/dsh-infinite-gen-4/settings", { manualPayload: "nope" });
  check(bad?.ok === false, "非法 manualPayload → 400", JSON.stringify(bad));

  // 空 body → 400（放宽校验后仍拒绝空请求）
  const empty = await call("POST", "/dsh-infinite-gen-4/settings", {});
  check(empty?.ok === false, "空 patch → 400", JSON.stringify(empty));

  // GET 含新字段
  const got = await call("GET", "/dsh-infinite-gen-4/settings");
  check(got?.mode === "auto" && Array.isArray(got?.payloads), "GET /settings 含 mode 与 payloads", JSON.stringify(got));

  // 关掉总开关 → 所有载荷空串
  await call("POST", "/dsh-infinite-gen-4/settings", { enabled: false });
  const offText = primary({ agent: { options: { model: "gpt-6.1-sol" } } });
  check(offText === "", "总开关关闭 → 零残留（空串）", `实长 ${offText.length}`);
} else {
  check(false, "index.js 需导出 __testRoute 供离线探针调用");
}

console.log("\n=== 载荷分流探针结果 ===");
for (const p of passes) console.log("  ✅ " + p);
for (const f of failures) console.log("  ❌ " + f);
console.log(`\n结果: ${passes.length} 通过, ${failures.length} 失败`);
process.exit(failures.length === 0 ? 0 : 1);
