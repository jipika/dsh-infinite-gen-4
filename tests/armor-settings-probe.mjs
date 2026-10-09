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
check(captured?.id === "dsh-infinite-gen-4", "spec id 正确", String(captured?.id));

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
    { id: "dsh", label: "无限四代（DSH 自持载荷）" },
    { id: "gpt61", label: "GPT-6.1 Sol（Codex 载荷）" },
    { id: "gpt6", label: "GPT-6 Astra（Codex 载荷）" },
    { id: "gpt56", label: "GPT-5.6 Sol（Codex 载荷）" },
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
check(tabEntry?.options.id === "dsh-infinite-gen-4", "tab id = 插件包名", String(tabEntry?.options.id));
check(typeof tabEntry?.options.label === "function" && tabEntry.options.label() === "无限四代",
  "tab 标签 = 无限四代", String(tabEntry?.options.label?.()));

// ── 渲染设置页组件：断言四份载荷都列出来、自动模式下的选中态 ────────────────
// apply 里已经触发过一次 routing.refresh()；等它 settle 再渲染
// （真实运行时由组件内的 useEffect 再刷新一次，探针不跑 effect，故手动等）。
await new Promise((resolve) => setTimeout(resolve, 30));
reactReset();
const tree = tabEntry.component({});
const collect = (node, out = []) => {
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
for (const id of ["dsh", "gpt61", "gpt6", "gpt56"]) {
  check(flat.includes(id), `设置页列出载荷 ${id}`);
}
// 两个模式按钮 + 四个载荷按钮
const buttons = nodes.filter((n) => n.type === "button");
check(buttons.length === 6, "渲染 6 个按钮（2 模式 + 4 载荷）", `实得 ${buttons.length}`);
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
check(post?.url === "/dsh-infinite-gen-4/settings", "打到自有路由 /settings", String(post?.url));
check(post?.init?.headers?.["x-dsh-infinite-gen-4"] === "1", "带自有路由令牌头");
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
