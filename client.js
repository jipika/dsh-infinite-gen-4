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

        /* 模块级依赖只声明基础服务，保证 client 半边一定加载：
           - `remote.settings` 作为「可注入服务名」在运行时不保证回调（ctx.inject 版本实测拿不到），
             写进模块级又会在服务缺席时整块不加载（连状态条一起消失）→ 改为 apply 里直接读属性；
           - 拿不到表单面时退回 host 半的自有路由 /dsh-infinite-gen-4/settings（一定可用）。 */
        var inject = ["slots", "remote"];

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
         * 开关状态源：宿主 settings 表单面（0.2.x 的 ctx.remote.settings）。
         * describe() 取真值与 revision，mutate() 写回 profile patch；写完全量 re-describe 校准，
         * 失败也回读，UI 始终收敛到宿主权威值。
         * getSnapshot 返回按引用缓存的对象，满足 useSyncExternalStore 的稳定性要求。
         * @returns 状态源（store / attach / refresh / set / hasScope）。
         */
        function createSettingSource() {
          var state = { value: false, status: "loading", writable: false, reason: "" };
          var clientCtx;
          // 当前会话 id（来自 host 投影的 armor.sessionId）；为空时开关退化为全局语义
          var sessionId;
          var revision;
          var listeners = new Set();
          var publish = function (next) {
            var reason = next.reason === void 0 ? "" : next.reason;
            if (next.value === state.value && next.status === state.status && next.writable === state.writable && reason === state.reason) return;
            state = { value: next.value, status: next.status, writable: next.writable, reason: reason };
            listeners.forEach(function (listener) { listener(); });
          };
          var settingsApi = function () {
            return clientCtx !== void 0 && clientCtx.remote !== void 0 ? clientCtx.remote.settings : void 0;
          };
          var httpHeaders = function (json) {
            var headers = { "x-dsh-infinite-gen-4": "1" };
            if (json) headers["content-type"] = "application/json";
            return headers;
          };
          /** 是否按会话读写：拿到会话 id 走会话路由，否则回落全局。 */
          var hasSession = function () {
            return typeof sessionId === "string" && sessionId.length > 0;
          };
          /** 自有路由读：有会话 id 读会话维度，否则读全局（返回形态都是 { ok, enabled, … }）。 */
          var httpGet = function () {
            var url = hasSession()
              ? "/dsh-infinite-gen-4/session?id=" + encodeURIComponent(sessionId)
              : "/dsh-infinite-gen-4/settings";
            return fetch(url, { headers: httpHeaders(false) }).then(
              function (response) { return response.ok ? response.json() : void 0; },
              function () { return void 0; }
            );
          };
          /**
           * 自有路由写：host 先试 settings.update 持久化，写不动则内存覆盖。
           * @param {boolean} value 目标值。
           * @param {string} [scope] 传 "global" 强制写全局（⌥ 点击走这条）。
           */
          var httpPost = function (value, scope) {
            var session = scope !== "global" && hasSession();
            return fetch(session ? "/dsh-infinite-gen-4/session" : "/dsh-infinite-gen-4/settings", {
              method: "POST",
              headers: httpHeaders(true),
              body: JSON.stringify(session ? { sessionId: sessionId, enabled: value } : { enabled: value })
            }).then(
              function (response) { return response.ok ? response.json() : void 0; },
              function () { return void 0; }
            );
          };
          /**
           * 超时包装：remote 通道实测可能永不 settle（挂起会把开关永久锁在 pending），
           * 所有 remote 调用都必须过它，超时即视为失败、交给另一条通道。
           */
          var withTimeout = function (promise, ms) {
            return new Promise(function (resolve) {
              var done = false;
              var timer = setTimeout(function () {
                if (done) return;
                done = true;
                resolve(void 0);
              }, ms);
              Promise.resolve(promise).then(
                function (value) { if (!done) { done = true; clearTimeout(timer); resolve(value); } },
                function () { if (!done) { done = true; clearTimeout(timer); resolve(void 0); } }
              );
            });
          };
          /** 从 describe() 结果里取出本插件的描述符（ns === profile entry id）。 */
          var pickDescriptor = function (result) {
            if (result === void 0 || result === null || result.ok !== true) return void 0;
            var list = Array.isArray(result.value) ? result.value : [];
            for (var i = 0; i < list.length; i += 1) {
              if (list[i] !== null && typeof list[i] === "object" && list[i].ns === SETTINGS_NAMESPACE) return list[i];
            }
            return void 0;
          };
          /** 不可用时保留原因：直接显示在开关 tooltip 里，区分「通道不可用」与「调用被拒」。 */
          var markUnavailable = function (reason) {
            publish({ value: state.value, status: "unavailable", writable: false, reason: reason });
          };
          /** 自有路由读：成功即采用（真值、以及写不动时的内存覆盖都能从这里看到）。 */
          var readViaRoute = function () {
            return httpGet().then(function (payload) {
              if (payload === void 0 || payload.ok !== true) return false;
              publish({ value: payload.enabled === true, status: "ready", writable: true, reason: "" });
              return true;
            });
          };
          /** 表单面读（remote.settings.describe）：只在自有路由不可用时才轮到它。 */
          var readViaRemote = function () {
            var api = settingsApi();
            if (api === void 0 || typeof api.describe !== "function") return Promise.resolve(false);
            return withTimeout(api.describe(), 3000).then(function (result) {
              if (result === void 0 || result === null || result.ok !== true) return false;
              var row = pickDescriptor(result);
              if (row === void 0) return false;
              revision = row.revision;
              var value = row.value !== null && typeof row.value === "object" ? row.value : {};
              publish({ value: value[SETTINGS_FIELD] === true, status: "ready", writable: true, reason: "" });
              return true;
            });
          };
          /** 读状态：自有路由优先，表单面兜底 —— 两条都失败才判定为只读。 */
          var sync = function () {
            if (clientCtx === void 0) return Promise.resolve();
            return readViaRoute().then(function (ok) {
              if (ok) return void 0;
              return readViaRemote().then(function (remoteOk) {
                if (!remoteOk) markUnavailable("自有路由与设置表单面都不可用");
              });
            });
          };
          /** 表单面写（remote.settings.mutate）：带超时；被拒时校准 revision 重试一次。 */
          var writeViaRemote = function (value) {
            var api = settingsApi();
            if (api === void 0 || typeof api.mutate !== "function") return Promise.resolve();
            var ops = [{ op: "set", path: [SETTINGS_FIELD], value: value }];
            return withTimeout(api.mutate(SETTINGS_NAMESPACE, ops, revision), 3000).then(function (result) {
              if (result === void 0 || result === null || result.ok === true) return void 0;
              return sync().then(function () {
                var retryApi = settingsApi();
                if (retryApi === void 0 || typeof retryApi.mutate !== "function") return void 0;
                return withTimeout(retryApi.mutate(SETTINGS_NAMESPACE, ops, revision), 3000);
              });
            });
          };
          /** 写开关：自有路由优先（host 内部会先试着持久化到 profile patch），失败再退表单面。 */
          var write = function (value, scope) {
            var toRemote = function () { return writeViaRemote(value).then(sync, function () { return sync(); }); };
            return httpPost(value, scope).then(
              function (payload) {
                if (payload !== void 0 && payload.ok === true) return sync();
                return toRemote();
              },
              function () { return toRemote(); }
            );
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
              clientCtx = next;
              sync();
              return function () { clientCtx = void 0; };
            },
            refresh: sync,
            /** 会话 id 变更（投影下发 / 切换会话）：重置为 loading 并重读该会话真值。 */
            useSession: function (next) {
              var normalized = typeof next === "string" && next.length > 0 ? next : void 0;
              if (normalized === sessionId) return;
              sessionId = normalized;
              publish({ value: state.value, status: "loading", writable: state.writable, reason: state.reason });
              sync();
            },
            /** 默认写入：有会话 id 就写本会话覆盖，否则写全局。 */
            set: function (value) {
              // 乐观更新：写完由 sync() 拉回权威值
              publish({ value: value, status: state.status, writable: state.writable, reason: state.reason });
              return write(value);
            },
            /** ⌥ 点击：强制写全局（新会话继承它）。 */
            setGlobal: function (value) {
              publish({ value: value, status: state.status, writable: state.writable, reason: state.reason });
              return write(value, "global");
            },
            sessionScope: function () { return hasSession(); },
            hasScope: function () { return clientCtx !== void 0; }
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
          // pending / 不可写 / 通道缺席时保持可聚焦（用于显示原因 tooltip），仅在 on 上取拦截。
          // writable 只在 ready 之后才有意义：加载瞬间不拦（否则首次点击会被吞掉）。
          var locked = pending || !available || (snap.status === "ready" && !snap.writable);

          // 作用域：有会话 id 时点一下切「本会话」，⌥ 点击切「全局」
          var scoped = setting.sessionScope();
          var scopeWord = scoped ? "本会话" : "全局";
          var title = !available
            ? "开关通道不可用（" + (snap.reason || "原因未明") + "）：只读显示 host 投影真值；也可在 profile 的 cordis.patch.yml 里改 dsh-infinite-gen-4 的 config.enabled"
            : snap.status === "ready" && !snap.writable
              ? "开关不可写：" + (snap.reason || "宿主拒绝了写入")
              : checked
                ? "无限四代注入已开启（" + scopeWord + "）— 点击关闭" + (scoped ? "；⌥ 点击切全局" : "")
                : "无限四代注入已关闭（" + scopeWord + "）— 点击开启" + (scoped ? "；⌥ 点击切全局" : "");
          var ariaLabel = props && typeof props.ariaLabel === "string" ? props.ariaLabel : "无限四代注入开关";

          var onClick = function (event) {
            if (locked) return;
            var next = !checked;
            var global = !!(event && event.altKey) || !scoped;
            setPending(true);
            // 硬复位：任何通道挂起（remote 实测可永不 settle）都不能把开关永久锁死
            window.setTimeout(function () { setPending(false); }, 5000);
            Promise.resolve(global ? setting.setGlobal(next) : setting.set(next)).then(
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
              disabled: pending || !available,
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
          // settings 通道缺席时以 host 投影下发的真值为准，避免误报「已关闭」。
          var projected = armor && typeof armor.enabled === "boolean" ? armor.enabled : void 0;
          // 会话身份由 host 投影下发（init 从会话 header 取 id）；拿到就按会话开关，拿不到退全局
          var sessionId = armor && typeof armor.sessionId === "string" ? armor.sessionId : void 0;
          react.useEffect(function () { setting.useSession(sessionId); }, [sessionId]);
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
          // 状态条视觉不变，作用域只在 tooltip 里区分（本会话 / 全局）
          var scopeLabel = sessionId !== void 0 ? "本会话" : "全局";

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
            ? "无限四代 v" + VERSION + " — " + scopeLabel + "注入开启中"
            : "无限四代 — " + scopeLabel + "已关闭（系统提示词零残留）";

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
          // 0.2.x：宿主 settings 表单面（ctx.remote.settings，模块级 inject 已声明 → apply 时保证可用）。
          // 绑定失败只让开关退回只读（真值仍由 host 投影下发），不影响状态条渲染；
          // settings/document-updated 事件用于设置页改动时同步刷新。
          ctx.effect(function () {
            var unbind = setting.attach(ctx);
            var remote = ctx.remote;
            var off = remote !== void 0 && typeof remote.$on === "function"
              ? remote.$on("settings/document-updated", function (ns) {
                  if (ns === void 0 || ns === SETTINGS_NAMESPACE) setting.refresh();
                })
              : void 0;
            return function () {
              if (typeof off === "function") off();
              if (typeof unbind === "function") unbind();
            };
          }, "infinite-gen-4: settings form binding");
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
