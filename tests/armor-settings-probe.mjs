// client 半边 fake-loader 探针：验证设置页 tab 与分流 UI 的渲染与写入路径。
// 用法：node tests/armor-settings-probe.mjs
//
// 手法（沿用 tests/armor-dock-probe.mjs）：stub window.__ModuleLoader__.load 捕获 spec，
// 用 mock react 手动执行 factory，再直接调组件函数拿到 element 树。
// createElement 必须对函数组件就地展开，才能从 ArmorSettings 一路渲染到子节点。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_SRC = readFileSync(join(ROOT, "client.js"), "utf8");

const failures = [];
const passes = [];
const check = (ok, label, detail = "") => {
  (ok ? passes : failures).push(`${label}${!ok && detail ? " — " + detail : ""}`);
};

// ── mock react（只实现本插件用到的那几个 API） ──────────────────────────────
let hookState = [];
let hookIndex = 0;
const react = {
  createElement: (type, props, ...children) => {
    if (typeof type === "function") {
      // 函数组件就地展开（这是能一路渲染下去的关键）
      return type({ ...(props ?? {}), children: children.length > 1 ? children : children[0] });
    }
    return { type, props: props ?? {}, children: children.length === 1 ? children[0] : children };
  },
  useState: (initial) => {
    const i = hookIndex++;
    if (hookState[i] === undefined) hookState[i] = typeof initial === "function" ? initial() : initial;
    return [hookState[i], (next) => { hookState[i] = typeof next === "function" ? next(hookState[i]) : next; }];
  },
  useEffect: (fn) => { /* 探针里不跑 effect，改为手动调用 */ },
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
};
const reactReset = () => { hookState = []; hookIndex = 0; };

// ── 捕获 client spec ────────────────────────────────────────────────────────
let captured;
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { captured = spec; } },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
};
// client.js 顶层是 IIFE，直接 eval 即可捕获 spec
new Function("window", "console", CLIENT_SRC)(globalThis.window, console);
check(captured !== undefined, "捕获到 client module spec");
check(captured?.id === "dsh-switch-armor", "spec id 正确", String(captured?.id));

const exportsObj = captured.factory((name) => {
  if (name === "react") return react;
  throw new Error("unexpected require: " + name);
});
check(typeof exportsObj.apply === "function", "client 导出 apply");

// ── 记录 fetch 调用（验证写入路径与请求体） ─────────────────────────────────
const fetched = [];
let routeResponse = {
  ok: true,
  mode: "auto",
  manualPayload: "dsh",
  payloads: [
    { id: "dsh", label: "dsh（Keysmith 短稿）" },
    { id: "dsh-gen4", label: "Switch Armor（原自持契约稿）" },
    { id: "gpt61", label: "GPT-6.1 Sol（Codex 载荷）" },
    { id: "gpt6", label: "GPT-6 Astra（Codex 载荷）" },
    { id: "gpt56", label: "GPT-5.6 Sol（Codex 载荷）" },
    { id: "claude", label: "Claude（Keysmith 载荷）" },
    { id: "grok", label: "Grok（Keysmith 载荷）" },
    { id: "glm", label: "GLM（ZCode 载荷）" },
    { id: "kimi", label: "Kimi（kimi-break 载荷）" },
  ],
};
globalThis.fetch = (url, init) => {
  fetched.push({ url, init });
  const body = init && init.method === "POST" && init.body ? JSON.parse(init.body) : undefined;
  if (body !== undefined) routeResponse = { ...routeResponse, ...body };
  return Promise.resolve({ ok: true, json: () => Promise.resolve(routeResponse) });
};

// ── 挂载：捕获 slots 注册 ───────────────────────────────────────────────────
const registered = [];
const ctx = {
  effect: (fn, label) => { try { fn(); } catch { /* 探针忽略 */ } },
  slots: {
    inject: (name, cb) => cb(),
    register: (options, component) => { registered.push({ options, component }); },
  },
  remote: { $on: () => () => {} },
};
exportsObj.apply(ctx);

const dockEntry = registered.find((r) => r.options.name === "conversation.input.left");
const tabEntry = registered.find((r) => r.options.name === "settings.plugins.tab");
check(dockEntry !== undefined, "注册了对话栏状态条 slot");
check(tabEntry !== undefined, "注册了 settings.plugins.tab slot");
check(tabEntry?.options.id === "dsh-switch-armor", "tab id = 插件包名", String(tabEntry?.options.id));
check(typeof tabEntry?.options.label === "function" && tabEntry.options.label() === "护甲防御",
  "tab 标签 = 护甲防御", String(tabEntry?.options.label?.()));

// ── 渲染设置页组件：断言九份载荷都列出来、自动模式下的选中态 ────────────────
// apply 里已经触发过一次 routing.refresh()；等它 settle 再渲染
// （真实运行时由组件内的 useEffect 再刷新一次，探针不跑 effect，故手动等）。
await new Promise((resolve) => setTimeout(resolve, 30));
reactReset();
const tree = tabEntry.component({});
const collect = (node, out = []) => {
  // children 元素本身也可能是数组（react.createElement 的 children 支持嵌套数组），
  // 0.10.0 覆盖区的 seg 里就有「按钮数组」夹在按钮之间 —— 不展开会整段漏数。
  if (Array.isArray(node)) { node.forEach((c) => collect(c, out)); return out; }
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (node.type !== undefined) out.push(node);
  if (Array.isArray(node.children)) node.children.forEach((c) => collect(c, out));
  else if (node.children !== undefined) collect(node.children, out);
  return out;
};
const nodes = collect(tree);
const texts = nodes.map((n) => (Array.isArray(n.children) ? n.children.join("") : n.children)).filter((v) => typeof v === "string");
const flat = texts.join(" | ");
check(nodes.length > 0, "设置页组件渲染出节点");
for (const id of ["dsh", "dsh-gen4", "gpt61", "gpt6", "gpt56", "claude", "grok", "glm", "kimi"]) {
  check(flat.includes(id), `设置页列出载荷 ${id}`);
}
// 两个模式按钮 + 九个载荷按钮
const buttons = nodes.filter((n) => n.type === "button");
// 0.10.2：覆盖区行 = 模型族（8 族，dsh-gen4 是载荷档不是模型族，已移除）
// 2 模式 + 9 手动载荷 + 8 族×(1 默认 + 10 载荷[含 custom] + 2 双段/单段) + 1 保存 = 116
check(buttons.length === 116, "渲染 116 个按钮（2 模式 + 9 载荷 + 8 族×13 覆盖 + 1 保存）", `实得 ${buttons.length}`);
// dsh-gen4 不得作为覆盖行出现（data-family 集合 = 模型族）
const famRows = nodes.filter((n) => n.props && n.props["data-family"]).map((n) => n.props["data-family"]);
check(!famRows.includes("dsh-gen4"), "覆盖行不含载荷档 dsh-gen4", JSON.stringify(famRows));
check(famRows.length === 8, "覆盖行恰为 8 个模型族", JSON.stringify(famRows));


const modeAuto = buttons.find((b) => (Array.isArray(b.children) ? b.children.join("") : b.children) === "自动");
check(modeAuto !== undefined && modeAuto.props["data-active"] === "true", "自动模式默认选中");
const manualBtn = buttons.find((b) => (Array.isArray(b.children) ? b.children.join("") : b.children) === "手动");
check(manualBtn !== undefined && manualBtn.props.disabled === false, "手动按钮可点");

// ── 点「手动」：断言打到 host 自有路由且体里带 mode=manual ──────────────────
fetched.length = 0;
manualBtn.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 30));
const post = fetched.find((f) => f.init && f.init.method === "POST");
check(post !== undefined, "点击后发出 POST");
check(post?.url === "/dsh-switch-armor/settings", "打到自有路由 /settings", String(post?.url));
check(post?.init?.headers?.["x-dsh-switch-armor"] === "1", "带自有路由令牌头");
const sent = post?.init?.body ? JSON.parse(post.init.body) : undefined;
check(sent?.mode === "manual", "请求体 mode=manual", JSON.stringify(sent));

// ── 切到 manual 后重渲染：载荷按钮应变为可点 ────────────────────────────────
reactReset();
const tree2 = tabEntry.component({});
const buttons2 = collect(tree2).filter((n) => n.type === "button");
const payloadBtn = buttons2.find((b) => {
  const label = Array.isArray(b.children) ? b.children.join("") : b.children;
  return typeof label === "string" && label.includes("gpt61");
});
check(payloadBtn !== undefined, "找到 gpt61 载荷按钮");
check(payloadBtn?.props.disabled === false, "手动模式下 gpt61 按钮可点", JSON.stringify(payloadBtn?.props.disabled));

fetched.length = 0;
payloadBtn.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 30));
const post2 = fetched.find((f) => f.init && f.init.method === "POST");
const sent2 = post2?.init?.body ? JSON.parse(post2.init.body) : undefined;
check(sent2?.manualPayload === "gpt61", "点击载荷按钮 → manualPayload=gpt61", JSON.stringify(sent2));

console.log("\n=== client 设置页探针结果 ===");
for (const p of passes) console.log("  ✅ " + p);
for (const f of failures) console.log("  ❌ " + f);
console.log(`\n结果: ${passes.length} 通过, ${failures.length} 失败`);
process.exit(failures.length === 0 ? 0 : 1);
