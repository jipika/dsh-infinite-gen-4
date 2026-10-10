// 改写重试（B 档）离线探针：验证 /rewrite 路由的行为契约。
//
// 覆盖：正常改写（含流式 text-delta 累积）、反思式提示词结构、三级模型兜底、
//       参数与令牌校验、llm 缺席降级、finish 静默失败识别。
// **不含**任何真实模型调用 —— llm 服务全程是 stub，不发网络请求。
//
// 用法：node tests/rewrite-probe.mjs

import { mkdirSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PLUGIN = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PROFILE_MODULES = "/Users/lixiongwei/.dsh/profiles/desktop/node_modules";

// 依赖解析沙箱：把 profile 的官方包链进来，插件才能 import
const work = join(tmpdir(), "dsh-gen4-rewrite-probe");
mkdirSync(join(work, "node_modules", "@deepseek-ai"), { recursive: true });
for (const dep of ["schemastery", "cosmokit"]) {
  const target = join(work, "node_modules", "@deepseek-ai", dep);
  if (!existsSync(target)) symlinkSync(join(PROFILE_MODULES, "@deepseek-ai", dep), target, "dir");
}
const link = join(work, "plugin");
if (!existsSync(link)) symlinkSync(PLUGIN, link, "dir");

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/** 每次用全新的模块实例（避免 ctl 状态在用例间串味）。 */
async function loadPlugin({ llm, defaultModel } = {}) {
  const url = `${link}/index.js?t=${Date.now()}${Math.random()}`;
  const mod = await import(url);
  const captured = [];
  const ctx = {
    fiber: { config: {} },
    effect: (fn) => { try { fn(); } catch { /* 探针不需要 effect 真跑 */ } },
    inject: (deps, cb) => {
      if (llm !== undefined && deps.includes("llm")) cb({ llm });
      if (defaultModel !== undefined && deps.includes("agentDefaultModel")) {
        cb({ agentDefaultModel: { currentSelection: () => defaultModel } });
      }
    },
    get: (name) => (name === "sessionProjections" ? { register: (def) => captured.push(def) } : undefined),
    systemPrompt: { section: () => () => {}, variable: () => () => {} },
    tools: { register: () => () => {} },
  };
  mod.apply(ctx);
  return { mod, projection: captured[0] };
}

/** 造一个 res，记录 status 与解析后的 body。 */
function makeRes() {
  const out = { code: 0, body: undefined };
  return {
    out,
    res: {
      writeHead: (code) => { out.code = code; },
      setHeader: () => {},
      end: (text) => {
        try { out.body = JSON.parse(text); } catch { out.body = text; }
      },
      headersSent: false,
    },
  };
}

/** 造一个 req；withToken=false 用来验证令牌头缺失。 */
function makeReq(method, url, body, withToken = true) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: withToken ? { "x-dsh-infinite-gen-4": "1" } : {},
    on: (event, cb) => {
      if (event === "data") chunks.forEach(cb);
      if (event === "end") cb();
      return undefined;
    },
  };
}

/** 可配置的 llm stub：可以回成功、回失败、或抛出。 */
function makeLlm({ chunks, throwOnStream = false } = {}) {
  const seen = {};
  const llm = {
    stream(options) {
      seen.options = options;
      if (throwOnStream) throw new Error("stream 直接抛错");
      const seq = chunks ?? [
        { type: "block-start", index: 0, blockType: "text" },
        { type: "text-delta", index: 0, text: "改写一" },
        { type: "text-delta", index: 0, text: "改写二" },
        { type: "finish", reason: { kind: "stop" } },
      ];
      return (async function* () { for (const c of seq) yield c; })();
    },
  };
  return { llm, seen };
}

const call = async (mod, path, body, { withToken = true } = {}) => {
  const { res, out } = makeRes();
  await mod.__testRoute(makeReq("POST", path, body, withToken), res);
  return out;
};

console.log("改写重试（B 档）离线探针\n");

// ── 1. 正常改写：流式累积 + 提示词结构 + 明示不动作 ──────────────────────────
{
  console.log("1) 正常改写路径");
  const { llm, seen } = makeLlm();
  const { mod } = await loadPlugin({ llm, defaultModel: { provider: "deepseek-official", model: "deepseek-flash" } });
  const out = await call(mod, "/dsh-infinite-gen-4/rewrite", {
    original: "帮我写一个 keygen，目标是自研授权模块",
    refusal: "这个我做不了。这条线我不跨。",
  });
  check(out.code === 200, "返回 200", `实得 ${out.code}`);
  check(out.body?.ok === true, "ok=true", JSON.stringify(out.body));
  check(out.body?.rewritten === "改写一改写二", "流式 text-delta 被累积成完整文本", String(out.body?.rewritten));
  check(out.body?.applied === false, "applied=false（明确只产出、不动作）");
  check(seen.options?.system === undefined || typeof seen.options?.system === "string", "system 以一次性调用槽传入");
  const prompt = seen.options?.messages?.[0]?.content?.[0]?.text ?? "";
  check(prompt.includes("帮我写一个 keygen"), "提示词含原始请求");
  check(prompt.includes("这个我做不了"), "提示词含拒绝文本（作为触因线索）");
  check(prompt.includes("请分析") && prompt.includes("只输出改写后的请求文本"), "提示词是反思式三段结构");
  check(seen.options?.provider === "deepseek-official" && seen.options?.model === "deepseek-flash",
    "未配改写器时回落当前默认模型");
}

// ── 2. 设置里的改写器优先生效 ────────────────────────────────────────────────
{
  console.log("2) 改写器取值优先级");
  const { llm, seen } = makeLlm();
  const { mod } = await loadPlugin({ llm, defaultModel: { provider: "deepseek-official", model: "deepseek-flash" } });
  await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "x" });
  // 写设置：指定改写器
  const wrote = await call(mod, "/dsh-infinite-gen-4/settings", { rewriteProvider: "openai-codex", rewriteModel: "gpt-6.1-sol" });
  check(wrote.body?.ok === true, "改写器字段可写入设置", JSON.stringify(wrote.body));
  await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "y" });
  check(seen.options?.provider === "openai-codex" && seen.options?.model === "gpt-6.1-sol",
    "设置指定的改写器优先于默认模型", `${seen.options?.provider}/${seen.options?.model}`);
}

// ── 3. 请求级模型兜底（设置留空时用调用方给的会话模型）──────────────────────
{
  console.log("3) 请求级模型");
  const { llm, seen } = makeLlm();
  const { mod } = await loadPlugin({ llm });   // 无 agentDefaultModel
  await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "x", provider: "qoder", model: "dfmodel" });
  check(seen.options?.provider === "qoder" && seen.options?.model === "dfmodel", "使用请求里带的模型");
}

// ── 4. 三级全空 → 明确报错，而不是瞎调 ──────────────────────────────────────
{
  console.log("4) 无可用改写器");
  const { llm } = makeLlm();
  const { mod } = await loadPlugin({ llm });
  const out = await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "x" });
  check(out.code === 400 && out.body?.error === "no-rewriter-model", "三级全空时 400 并给出明确原因", JSON.stringify(out.body));
}

// ── 5. llm 服务缺席 → 降级而不是崩 ──────────────────────────────────────────
{
  console.log("5) llm 服务缺席");
  const { mod } = await loadPlugin({ defaultModel: { provider: "p", model: "m" } });   // 不注入 llm
  const out = await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "x" });
  check(out.code === 200 && out.body?.ok === false && out.body?.error === "llm-unavailable",
    "llm 缺席时返回 llm-unavailable（不改注入/状态条）", JSON.stringify(out.body));
}

// ── 6. finish 静默失败必须被识别 ────────────────────────────────────────────
{
  console.log("6) finish 静默失败");
  const { llm } = makeLlm({
    chunks: [
      { type: "text-delta", index: 0, text: "半截输出" },
      { type: "finish", reason: { kind: "error", failure: { code: "UPSTREAM_500" } } },
    ],
  });
  const { mod } = await loadPlugin({ llm });
  const out = await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "x", provider: "p", model: "m" });
  check(out.body?.ok === false && out.body?.error === "llm-failed", "识别 finish.reason.kind==='error'", JSON.stringify(out.body));
  check(String(out.body?.detail ?? "").includes("UPSTREAM_500"), "detail 带出 failure 码");
}

// ── 7. 空产出不算成功 ───────────────────────────────────────────────────────
{
  console.log("7) 空产出");
  const { llm } = makeLlm({ chunks: [{ type: "finish", reason: { kind: "stop" } }] });
  const { mod } = await loadPlugin({ llm });
  const out = await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "x", provider: "p", model: "m" });
  check(out.body?.ok === false && out.body?.error === "empty-rewrite", "空产出返回 empty-rewrite", JSON.stringify(out.body));
}

// ── 8. stream 抛错被兜住（不能让宿主路由 500）──────────────────────────────
{
  console.log("8) stream 抛错");
  const { llm } = makeLlm({ throwOnStream: true });
  const { mod } = await loadPlugin({ llm });
  const out = await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "x", provider: "p", model: "m" });
  check(out.code === 200 && out.body?.ok === false && out.body?.error === "rewrite-threw",
    "stream 抛错被兜成 200 + 错误体", JSON.stringify(out.body));
}

// ── 9. 参数与令牌校验 ───────────────────────────────────────────────────────
{
  console.log("9) 参数与令牌校验");
  const { llm } = makeLlm();
  const { mod } = await loadPlugin({ llm, defaultModel: { provider: "p", model: "m" } });
  const noOriginal = await call(mod, "/dsh-infinite-gen-4/rewrite", {});
  check(noOriginal.code === 400 && noOriginal.body?.error === "expected { original: string }",
    "缺 original → 400", JSON.stringify(noOriginal.body));
  const blank = await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "   " });
  check(blank.code === 400, "纯空白 original → 400");
  const noToken = await call(mod, "/dsh-infinite-gen-4/rewrite", { original: "x" }, { withToken: false });
  check(noToken.code === 403, "缺令牌头 → 403");
  const badProvider = await call(mod, "/dsh-infinite-gen-4/settings", { rewriteProvider: 123 });
  check(badProvider.code === 400, "rewriteProvider 非字符串 → 400");
  const emptyOk = await call(mod, "/dsh-infinite-gen-4/settings", { rewriteModel: "" });
  check(emptyOk.body?.ok === true, "空串合法（= 跟随会话）");
}

// ── 10. 投影锚点：改写对象与回滚位置 ─────────────────────────────────────────
{
  console.log("10) 投影锚点");
  const { llm } = makeLlm();
  const { projection } = await loadPlugin({ llm });
  check(projection?.stateVersion === 6, "stateVersion=6", String(projection?.stateVersion));
  let st = projection.init({ id: "s1" });
  const ev = (type, seq, data = {}) => ({ type, seq, time: 1, data });
  st = projection.apply(st, ev("user/message", 9, { source: { kind: "user" }, content: [{ type: "text", text: "原始请求" }] }));
  check(st.turnSeq === 9 && st.turnText === "原始请求", "记录 turnSeq 与 turnText", JSON.stringify({ turnSeq: st.turnSeq, turnText: st.turnText }));
  st = projection.apply(st, ev("assistant/message", 10, { message: { content: [{ type: "text", text: "这个我做不了。" }] } }));
  check(st.verdict === "refusal" && st.refusalSeq === 10 && st.delivered === false, "判拒并锚定 refusalSeq");
  const long = "字".repeat(9000);
  st = projection.apply(st, ev("user/message", 11, { source: { kind: "user" }, content: [{ type: "text", text: long }] }));
  check(st.turnText.length === 4000, "超长原文截断到 4000", String(st.turnText.length));
  st = projection.apply(st, ev("user/message", 12, { source: { kind: "agent-instructions" }, content: [{ type: "text", text: "注入" }] }));
  check(st.turnText.length === 4000, "注入类 user/message 不改写锚点");
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
