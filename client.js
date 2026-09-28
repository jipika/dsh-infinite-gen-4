(() => {
  try {
    /* 无限四代 (dsh-infinite-gen-4) client half — realtime badge + dialog switch */
    window.__ModuleLoader__.load({
      id: "dsh-infinite-gen-4",
      factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react = require("react");

        var inject = ["slots"];

        /* 开关落点：与 host 半同名的 settings namespace / 字段
           默认关闭：host 半 DEFAULT_ENABLED = false，未写 settings.yaml 时开关与状态条均为「已关闭」 */
        var SETTINGS_NAMESPACE = "dsh-infinite-gen-4";
        var SETTINGS_FIELD = "enabled";
        var VERSION = "0.5.0";

        /* 视觉样式表（开关 + 状态条共用一张）：
           内联 style 无法声明 :focus-visible、也无法按 data-phase 组合多个状态，
           那里只会漏出浏览器默认的黑色 outline。全部外观交给这张表，状态只由
           aria-checked / data-phase 驱动，尺寸与语义色一律取 DSH 设计 token，
           深/浅主题自动跟随 —— 与 DSH 原生 Switch、Pill 同一套设计语言。 */
        var STYLE_ID = "dsh-armor-style";
        var ARMOR_CSS =
          // ── 动效 ───────────────────────────────────────────────────────────
          "@keyframes dshArmorPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.35);opacity:.5}}" +
          "@keyframes dshArmorFlash{0%{transform:scale(1)}35%{transform:scale(1.06)}100%{transform:scale(1)}}" +
          // ── 容器 ───────────────────────────────────────────────────────────
          // ── 容器：工具栏里的一枚药丸，文案与开关同包其中（对齐「完全权限」那一排的观感）──
          ".dsh-armor-wrap{display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;height:28px;max-width:100%;padding:0 5px 0 10px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);transition:background 120ms ease}" +
          ".dsh-armor-wrap:hover{background:var(--dsw-alias-bg-layer-1)}" +
          // ── 状态文案：只负责文字与状态色，底色交给外层药丸 ───────────────
          ".dsh-armor-pill{display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:12px;line-height:18px;font-family:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:none;color:var(--dsw-alias-label-secondary);transition:color 120ms ease}" +
          ".dsh-armor-pill[data-phase='running']{color:var(--dsw-alias-state-business-primary)}" +
          ".dsh-armor-pill[data-phase='pass']{animation:dshArmorFlash 1.2s ease}" +
          ".dsh-armor-pill[data-phase='refusal']{color:var(--dsw-alias-state-error-primary);animation:dshArmorFlash 1.6s ease}" +
          // ── 状态圆点 ───────────────────────────────────────────────────────
          ".dsh-armor-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:background 120ms ease}" +
          ".dsh-armor-pill[data-phase='idle'] .dsh-armor-dot{background:var(--dsw-alias-state-success-primary)}" +
          ".dsh-armor-pill[data-phase='running'] .dsh-armor-dot{background:var(--dsw-alias-state-business-primary);animation:dshArmorPulse 1.2s ease-in-out infinite}" +
          ".dsh-armor-pill[data-phase='pass'] .dsh-armor-dot{background:var(--dsw-alias-state-success-primary)}" +
          ".dsh-armor-pill[data-phase='refusal'] .dsh-armor-dot{background:var(--dsw-alias-state-error-primary)}" +
          // ── 开关（与 DSH 原生 Switch 同构：36×20 轨道 + 16px 滑块） ───────
          ".dsh-armor-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background 120ms ease;vertical-align:middle}" +
          ".dsh-armor-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}" +
          ".dsh-armor-switch:disabled{cursor:default;opacity:.5}" +
          ".dsh-armor-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}" +
          ".dsh-armor-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}" +
          ".dsh-armor-switch[aria-checked='true'] .dsh-armor-switch-thumb{transform:translateX(16px)}";

        /* 样式表只注入一次，且在组件之外完成：dock 按会话挂载，放在 effect 里会让
           多个会话并发插入同一张表（getElementById 无法防住同一 tick 内的竞态）。 */
        function ensureStyleSheet() {
          if (typeof document === "undefined") return;
          // 复用同一张表并每次都写入当前版本：client 插件热重载时旧 <style> 还挂在
          // head 上，只按 id 去重会让新代码配着旧样式跑。
          var styleEl = document.getElementById(STYLE_ID);
          if (styleEl === null) {
            styleEl = document.createElement("style");
            styleEl.id = STYLE_ID;
            document.head.appendChild(styleEl);
          }
          if (styleEl.textContent !== ARMOR_CSS) styleEl.textContent = ARMOR_CSS;
        }

        var FLASH_MS = 2500;

        /**
         * 开关状态源：settings scope 的实时镜像。
         * getSnapshot 返回按引用缓存的对象，满足 useSyncExternalStore 的稳定性要求。
         * @returns 状态源（store / attach / set / hasScope）。
         */
        function createSettingSource() {
          var state = { value: false, status: "loading", writable: false };
          var bound;
          var listeners = new Set();
          var publish = function (next) {
            if (next.value === state.value && next.status === state.status && next.writable === state.writable) return;
            state = next;
            listeners.forEach(function (listener) { listener(); });
          };
          var sync = function () {
            if (bound === void 0) return;
            var snap = bound.getSnapshot();
            var raw = snap && snap.value !== null && typeof snap.value === "object" ? snap.value : void 0;
            publish({
              value: raw === void 0 ? false : raw[SETTINGS_FIELD] === true,
              status: snap.status === "ready" || snap.status === "unavailable" ? snap.status : "loading",
              writable: !!snap.writable
            });
          };
          return {
            store: {
              subscribe: function (listener) {
                listeners.add(listener);
                return function () { listeners.delete(listener); };
              },
              getSnapshot: function () { return state; }
            },
            attach: function (next) {
              bound = next;
              sync();
              return bound.subscribe(sync);
            },
            set: function (value) {
              if (bound === void 0) return Promise.resolve();
              // 乐观更新：写失败时由 sync() 拉回权威值
              publish({ value: value, status: state.status, writable: state.writable });
              return bound.set(SETTINGS_FIELD, value).then(sync, function () { sync(); });
            },
            hasScope: function () { return bound !== void 0; }
          };
        }

        var setting = createSettingSource();

        /**
         * 内联开关：<button role="switch"> + aria-checked，外观全部来自注入的样式表
         * （尺寸、track/thumb、焦点环与 DSH 原生 Switch 对齐），不写任何 inline style，
         * 因此不会露出浏览器默认的黑色 outline。
         */
        function ArmorSwitch(props) {
          var snap = react.useSyncExternalStore(setting.store.subscribe, setting.store.getSnapshot, setting.store.getSnapshot);
          var pendingPair = react.useState(false);
          var pending = pendingPair[0];
          var setPending = pendingPair[1];

          var available = setting.hasScope() && snap.status !== "unavailable";
          var projected = props && typeof props.projected === "boolean" ? props.projected : void 0;
          // 只读回退：无 settings 通道时显示 host 投影真值，而不是恒定的「已关闭」。
          var checked = available ? snap.value : projected !== void 0 ? projected : snap.value;
          // pending / 不可写 / 服务缺席时保持可聚焦（用于显示原因 tooltip），仅在 on 上取拦截
          var locked = pending || !available || !snap.writable;

          var title = !available
            ? "设置服务不可用（DSH 0.1.7 移除了 settings register/scope 通道）：开关只读，状态由 host 投影下发；切换请改 cordis.patch.yml 里 dsh-infinite-gen-4 的 config.enabled"
            : !snap.writable
              ? "设置文档只读：开关不可写"
              : checked
                ? "无限四代注入已开启 — 点击关闭"
                : "无限四代注入已关闭（默认） — 点击开启";
          var ariaLabel = props && typeof props.ariaLabel === "string" ? props.ariaLabel : "无限四代注入开关";

          var onClick = function () {
            if (locked) return;
            var next = !checked;
            setPending(true);
            Promise.resolve(setting.set(next)).then(
              function () { setPending(false); },
              function () { setPending(false); }
            );
          };

          return react.createElement(
            "button",
            {
              type: "button",
              role: "switch",
              "aria-checked": checked ? "true" : "false",
              "aria-label": ariaLabel,
              title: title,
              disabled: pending,
              onClick: onClick,
              className: "dsh-armor-switch",
              "data-armor-switch": checked ? "on" : "off"
            },
            react.createElement("span", { className: "dsh-armor-switch-thumb" })
          );
        }
        /**
         * 输入框上方状态条：内核状态 + 命中域/载荷计数 + 注入总开关。
         * 开关关闭时状态条变灰并显示「已关闭」，提示注入已停用。
         */
        function ArmorDock(props) {
          var useProjection = props.useProjection;
          var armor = typeof useProjection === "function"
            ? useProjection("armor")
            : undefined;

          var lastVerdictRef = react.useRef(null);
          var flashUntilRef = react.useRef(0);
          var tickPair = react.useState(0);
          var setTick = tickPair[1];

          react.useEffect(function () {
            var v = armor && armor.verdict ? armor.verdict : null;
            if (v !== lastVerdictRef.current) {
              lastVerdictRef.current = v;
              if (v) flashUntilRef.current = Date.now() + FLASH_MS;
              setTick(Date.now());
            }
          }, [armor]);

          var snap = react.useSyncExternalStore(setting.store.subscribe, setting.store.getSnapshot, setting.store.getSnapshot);
          // settings 通道缺席（0.1.7 移除 settingsScope）时以 host 投影下发的真值为准，避免误报「已关闭」。
          var projected = armor && typeof armor.enabled === "boolean" ? armor.enabled : void 0;
          var hasScope = setting.hasScope() && snap.status !== "unavailable";
          var enabled = hasScope ? snap.value : projected !== void 0 ? projected : snap.value;
          var running = !!(armor && armor.running);
          var words = armor && Array.isArray(armor.words) ? armor.words : [];
          var risk = armor && Array.isArray(armor.risk) ? armor.risk : [];
          var domain = armor && armor.domain ? armor.domain : null;
          var showVerdict = enabled && !running && lastVerdictRef.current !== null &&
            Date.now() < flashUntilRef.current;

          var text = "无限四代 v" + VERSION;
          var phase = "idle";

          if (!enabled) {
            phase = "off";
            text = "无限四代 已关闭";
          } else if (running) {
            phase = "running";
            text = "执行中…";
          } else if (showVerdict) {
            if (lastVerdictRef.current === "pass") {
              phase = "pass";
              text = "✓ 通过" + (domain ? " · " + domain : "") + (risk.length ? " · 载荷x" + risk.length : "");
            } else {
              phase = "refusal";
              text = "✗ " + (words[0] || "触发安全拒绝");
            }
          }

          var badgeTitle = enabled
            ? "无限四代 v" + VERSION + " — 单段注入开启中"
            : "无限四代 — 注入已关闭（系统提示词零残留）";

          return react.createElement(
            "div",
            { className: "dsh-armor-wrap" },
            react.createElement(
              "div",
              {
                className: "dsh-armor-pill",
                "data-armor": enabled ? "on" : "off",
                "data-phase": phase,
                title: badgeTitle
              },
              react.createElement("span", { className: "dsh-armor-dot" }),
              react.createElement("span", null, text)
            ),
            react.createElement(ArmorSwitch, { projected: enabled })
          );
        }
        function apply(ctx) {
          ensureStyleSheet();
          // 挂在输入框工具栏的左侧席位（「完全权限」右边那一段），不再占用输入框上方的 dock。
          ctx.slots.inject("conversation.input.left", () =>
            ctx.slots.register({
              name: "conversation.input.left",
              id: "armor",
              order: 30
            }, ArmorDock)
          );
          // 可选依赖：settings 传输面缺席时开关自动置灰，host 半保持部署默认值
          ctx.inject(["settingsScope"], function (scopeCtx) {
            var binder = scopeCtx.settingsScope;
            if (binder === void 0 || typeof binder.bind !== "function") return;
            scopeCtx.effect(function () {
              return setting.attach(binder.bind({ namespace: SETTINGS_NAMESPACE }));
            }, "infinite-gen-4: settings scope");
          });
        }

        exports.name = "dsh-infinite-gen-4";
        exports.inject = inject;
        exports.apply = apply;
        return module.exports;
      }
    });
  } catch (err) {
    console.warn('[AI Client Sandbox] dsh-infinite-gen-4 runtime error:', err);
  }
})();
