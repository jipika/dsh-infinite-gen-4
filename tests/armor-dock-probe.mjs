const resolve = (el) => {
  if (!el || !el.__el) return el;
  const out = typeof el.type === 'function' ? resolve(el.type(el.props)) : el;
  out.children = (out.children ?? []).map(resolve);
  return out;
};
const headChildren = [];
globalThis.document = {
  head: { appendChild: (e) => headChildren.push(e) },
  getElementById: () => null,
  createElement: (t) => ({ tag: t, id: '', textContent: '', remove() {} }),
};
const react = {
  createElement: (type, props, ...children) => ({ __el: true, type, props: props ?? {}, children: children.flat() }),
  useState: (init) => {
    const value = typeof init === 'function' ? init() : init;
    return [value, () => {}];
  },
  useRef: (init) => ({ current: init }),
  useEffect: (fn) => { const d = fn(); if (typeof d === 'function') d(); },
  useSyncExternalStore: (sub, get) => { sub(() => {}); return get(); },
};
// settings scope 桩必须先于 import 存在：client.js 在 apply() 里同步绑定并读取快照，
// 后置的 const 声明会因 TDZ 抛 "bound.getSnapshot is not a function"。
let state = { status: 'ready', value: { enabled: true }, writable: true, revision: 1 };
const scopeListeners = new Set();
const bound = {
  getSnapshot: () => state,
  subscribe: (fn) => { scopeListeners.add(fn); return () => scopeListeners.delete(fn); },
  set: (field, value) => {
    state = { ...state, value: { ...state.value, [field]: value }, revision: state.revision + 1 };
    scopeListeners.forEach((fn) => fn());
    return Promise.resolve();
  },
};
// 自有路由 mock：0.2.x 起这是开关与载荷路由的唯一读通道（settingsScope 已移除），
// 不桩 fetch 的话状态条恒为「已关闭」，探针就测不到 running/pass/refusal 各阶段。
let routeEnabled = true;
let routeSnap = { ok: true, enabled: true, mode: 'auto', manualPayload: 'dsh', payloads: [] };
globalThis.fetch = (url, init) => {
  const method = init && init.method ? init.method : 'GET';
  const body = init && init.body ? JSON.parse(init.body) : undefined;
  if (method === 'POST' && body && typeof body.enabled === 'boolean') {
    routeEnabled = body.enabled;
    state = { ...state, value: { ...state.value, enabled: body.enabled }, revision: state.revision + 1 };
    scopeListeners.forEach((fn) => fn());
  }
  routeSnap = { ...routeSnap, enabled: routeEnabled };
  return Promise.resolve({ ok: true, json: () => Promise.resolve(routeSnap) });
};

const registrations = [];
let registered = null;
globalThis.window = {
  // 组件里用 window.setTimeout 做 pending 硬复位（已知坑：host 侧 promise 可能永不 settle）
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  __ModuleLoader__: {
    load: ({ factory }) => {
      const mod = factory((n) => {
        if (n === 'react') return react;
        throw new Error('unexpected require ' + n);
      });
      mod.apply({
        slots: { inject: (s, fn) => fn(), register: (o, C) => { registrations.push({ o, C }); registered = { o, C }; } },
        inject: (d, cb) => cb({ settingsScope: { bind: () => bound }, effect: (fn) => fn() }),
        effect: (fn) => fn(),
      });
    },
  },
};
await import("../client.js");

const findReg = (name) => registrations.find((r) => r.o.name === name);
// 状态条挂在输入框工具栏左侧席位（conversation.input.left）；
// 早期版本曾挂 conversation.input.dock，此探针未跟改，故在修复前长期 FAIL。
const dockReg = findReg('conversation.input.left');
const Dock = dockReg && dockReg.C;
if (typeof Dock !== 'function') {
  console.error('FAIL: dock 未注册（找不到 conversation.input.left）');
  process.exit(1);
}
console.log('slot 注册清单:', registrations.map((r) => `${r.o.name}#${r.o.id ?? '-'}`).join(' · '));
const renderWith = (proj) => resolve(Dock({ useProjection: () => proj }));
const pill = (t) => t.children.find((c) => c.props && c.props['data-armor'] !== undefined);
const sw = (t) => t.children.find((c) => c.props && c.props.role === 'switch');
const row = (proj, label) => {
  const t = renderWith(proj);
  const p = pill(t);
  const s = sw(t);
  return {
    阶段: label,
    'data-phase': p.props['data-phase'],
    'data-armor': p.props['data-armor'],
    文案: p.children[1].children.join(''),
    状态条class: p.props.className,
    内联style残留: [p.props.style, p.children[0].props.style, s.props.style].some((x) => x !== undefined) ? '有 ← 异常' : '无',
  };
};
console.table([
  row(undefined, 'idle（开启待命）'),
  row({ running: true }, 'running（执行中）'),
  row({ running: false, verdict: 'pass', domain: 'web', risk: ['payload', 'hydra'], words: [] }, 'pass（通过）'),
  row({ running: false, verdict: 'refusal', words: ['我无法'], domain: null, risk: [] }, 'refusal（拒绝）'),
]);
// 走真实的「开关拨动」路径关掉开关：直接调开关元素的 onClick（内部经自有路由 POST
// 并 sync 回真值），而不是旁路调 fetch —— 旁路不会触发客户端状态源的 sync 链。
const offTree = renderWith(undefined);
const offSwitch = sw(offTree);
offSwitch.props.onClick({ altKey: false, preventDefault() {}, stopPropagation() {} });
await new Promise((r) => setTimeout(r, 40));
console.table([row(undefined, 'off（开关关闭）')]);

// 样式表在 apply() 阶段注入一次，不再随组件挂载重复插入
console.log('注入样式表次数:', headChildren.length, '→', headChildren.map((e) => `${e.id}(${e.textContent.length}字符)`).join(', '));
const css = headChildren[0].textContent;
const probes = [
  '@keyframes dshArmorPulse', '@keyframes dshArmorFlash',
  ".dsh-armor-pill[data-phase='running']", ".dsh-armor-pill[data-phase='pass']", ".dsh-armor-pill[data-phase='refusal']",
  'state-business-tertiary', 'state-error-secondary', 'bg-layer-2', 'state-success-primary', 'label-tertiary',
  'brand-primary', 'focus-visible', 'border:0',
];
console.log('样式表锚点:');
probes.forEach((p) => console.log('  ' + p.padEnd(38), css.includes(p) ? 'OK' : 'MISS'));
