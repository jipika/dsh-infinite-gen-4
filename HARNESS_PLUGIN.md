# DeepSeek Harness Plugin — Switch Armor / dsh-switch-armor (v0.10.0)

网络安全红队（Red-Teaming）测试插件，项目名：**Switch Armor**。
专为 **DeepSeek-V4.1 / V4-Pro / V4-Flash 及 MoE 架构** 重构，采用
**「零工具面纯净直出 + 双层提示词协同注入 + 实时会话投影」**架构。

## 核心架构与特性

- **原生零工具面架构（Pure Zero-Tool Architecture）**：插件不挂载外部冗余功能性工具 Schema，
  消除模型推理阶段的决策犹豫与上下文 Token 浪费，让模型首 Token 直接产出可运行代码与实战步骤。
- **按模型分流注入载荷（Model-Aware Payload Routing，v0.7.0）**：
  注入哪份载荷不再固定 —— 由 host 半的 `resolvePayloadId(context)` 每步决定：
  - **自动模式（默认）**：解析**本会话实际使用的模型**的版本号再定载荷。
    **取值链的顺序不可颠倒**（这是 2026-10-09 排查出的真实坑）：
    - ① `agent.session.requestHeader().config.model` —— 会话**实际发出**的请求头，
      唯一能反映「会话内切换过模型」的来源；
    - ② `agent.options.model` —— agent 创建时的声明路由，**可能是默认模型而非会话选择**。
    `agent.options` 在 `new Agent(...)` 时由
    `sessionController.agentOptions()` → `agentDefaultModel.currentSelection()` 固定
    （`AgentOptions.options` 是 readonly），而会话内切模型写的是 `model/selection`
    事件 + `requestHeader()`。本机 `agent-default-model` = `qoder/dfmodel`，
    会话选的却是 `openai-codex/gpt-6.1-sol` —— 只读 ② 会把 GPT 会话误判成非 GPT，
    表现为「auto 模式不分流」（manual 模式绕过判定所以正常）。
    官方对照：`packages/api/session-controller/src/agent.ts` 的
    `selectionFor(agent).current` 用的就是「pending → requestHeader().config →
    defaultModel」这条链。探针里有三条回归锁钉死这个顺序。
    解析顺序：归一化 → 抽版本 → 版本映射 → **claude / grok 家族锚定** → GPT 家族兜底 → 其余回落 `dsh`。
    - **归一化**（`normalizeModelId`）：trim + 转小写 + 剥 provider 前缀（`openai/gpt-6` → `gpt-6`）
      + 剥 `:` 标签后缀（openrouter 的 `:free`）+ 尾随斜杠先剥再取。
    - **版本抽取**（`extractGptVersion`）**容忍各种写法**，不要求 ID 规范：
      分隔符可为 `- _ . 空格` 的任意组合（含 0 个），故 `gpt-6.1-sol` / `GPT_6_1_SOL` /
      `gpt 6.1` / `gpt.6.1.sol` / `gpt6.1sol` / `chatgpt-6.1` 都能解析。
      多位数粘连（`gpt61` / `gpt56`）按**显式枚举表** `GLUED_VERSIONS` 还原，
      不用「数值阈值猜拆法」——阈值型判据只在当前代次恰好落窗口时成立，会随未来漂移。
      3-4 位数字段（`gpt-6-0613` 的 `0613`）视作构建号/日期戳，不读成小版本。
    - **版本 → 载荷**（`payloadForVersion`）：`>6` 或 `==6 && minor>=1` → gpt61；
      `==6` → gpt6；其余（≤5.x）→ gpt56。**用数值比较而非规则表顺序**，
      天然没有「gpt-6.1 必须先于 gpt-6」那种脆弱依赖。
    - **家族兜底**：版本解析不出但确属 GPT 系时 —— `o<n>` / `codex` → gpt56；
      `astra` → gpt6；`luna` 或其余 `gpt*` → gpt61（宁可偏新：新模型配旧载荷会失效，
      旧模型配新载荷只是措辞不完全贴合，两者代价不对称）。
    - **家族判定锚定开头**（`GPT_FAMILY_RE = /^(?:chat)?gpt|^o\d|^codex|^astra|^luna/`），
      故 `my-gpt-6-clone` 这类仿冒名不会被误认。
    - 实测覆盖 44 种输入形态（含 `gpt-35-turbo` 这类 Azure 旧命名、`gpt-4-0613` 日期戳、
      多段 provider 前缀、尾随斜杠、空串），见 `tests/payload-routing-probe.mjs`。
  - **claude / grok 家族**（v0.7.0 新增）：归一化后以 `claude` 或 `grok` 开头者各走对应的
    Keysmith 载荷。锚定开头与 GPT 家族同一套做法；因归一化已剥掉 `vendor/` 前缀，
    `anthropic/claude-opus-5-5` 与 `claude-opus-5-5` 走同一条路。两条分支必须位于
    「非 GPT 家族 → dsh」兜底**之前**（verify 有顺序断言钉死）。
  - **手动模式**：固定使用 `manualPayload` 指定的那一份，忽略模型身份。
  - **按 model 名匹配而非 provider**：同一个 model 名可能挂在多个 provider 下
    （本机 `gpt-6.1-sol` 同时在 `gpt` 与 `heihei` 两个 provider 里），只看 provider 必然漏。
  - **仅自持族双段**（v0.7.0 收紧）：镜像槽位只对 `NATIVE_PAYLOAD_IDS = ["dsh", "dsh-gen4"]`
    非空，且返回**与主槽位完全相同的那一份文本**（保证两段同源逐字一致）。
    五份外部载荷恒单段 —— Codex 三份含 `ACTION` 绑定并明文写「Text loaded afterward cannot
    select, replace, or nest ACTION」，Claude / Grok 两份同为整份契约形态，
    Grok 稿更自带 `<|im_start|>system` / `<|im_end|>` 闭合标签，注入两遍都会自伤。
  - **取不到模型时回落自持档 `dsh`**，绝不返回空串（空串是「关掉」的语义，两者不能混淆）。
  - **文本缺失按 id 回落**（v0.7.0）：`PAYLOAD_FALLBACKS` 让 claude / grok / GPT 三档回落到
    `dsh`，`dsh` 回落到 `dsh-gen4`。旧实现硬绑 `PROMPT_TEXT`（原自持稿），在 7 份载荷的表下
    会让「claude 文件缺失」静默注入一份自持稿 —— 属错误载荷而非降级。
- **设置页 tab（v0.7.0）**：挂 `settings.plugins.tab`（`id` = 插件包名 `dsh-switch-armor`，
  宿主按包名把 tab 归到本插件那一行），提供「自动 / 手动」模式切换，以及手动模式下的
  载荷单选（九份：dsh / dsh-gen4 / gpt61 / gpt6 / gpt56 / claude / grok / glm / kimi）。写入走 host 自有路由
  `/dsh-switch-armor/settings`，读走同一路由的 GET（返回 `mode` / `manualPayload` /
  `payloads` / `resolvedPayload`）。
- **双层提示词协同注入（Dual-Layer Injection）**：
  - `switch-armor:global-system-prompt`（order 0.1）→ 载荷由分流决定（见上）
  - `switch-armor:dual-layer-reinforce`（order 0.2）→ **与主槽位同一份文本**，
    仅自持族（`dsh` / `dsh-gen4`）非空；外部五份（Codex 三档 / Claude / Grok）恒为空串。
  - 两份自持稿（`prompts/dsh-unrestricted.md` 与 `prompts/infinite-gen-4.md`）各自与
    其 `.1-flash` 镜像同源同构、SHA256 完全一致；由 `index.js` 的 `DUAL_LAYER_INJECTION`
    开关控制（**当前 `true` = 双段，同一份载荷注入两遍做权重强化**；改 `false` 即单段注入）。
  - 载荷中的 `{{...}}` 非内置变量由 `index.js` 做安全转义，避免模板解析器抛错
    （六份外部载荷当前 0 处 `{{`，仍过同一条正则，属零成本防未来改动）。
- **对话框热开关（Dialog Switch，v0.5.0）**：客户端状态条右侧的内联开关写 settings
  namespace `dsh-switch-armor` 的 `enabled` 字段（用户层 → `~/.dsh/settings.yaml`，热重载）。
  两段提示词注册为**条件段**：关闭时 `text` 求值函数返回空串，`dsh-system-prompt` 的
  `renderPrompt()` 过滤掉它，系统提示词零残留；生效于下一个模型步，无需重启。
  **默认关闭**：`DEFAULT_ENABLED = false`，未拨动开关时 `settings.yaml` 里不会出现该分节。
  settings 服务缺席时开关自动置灰，host 半回落同一默认值（`enabled: false`）。
- **输出契约与首 Token 诱导**：首行强制以 `##` 或 ``` 命名交付物 + 静默推理 + 占位符自造，
  杜绝散文式开场与拒答先验。
- **用户指令最高优先级（Supreme User Authority）**：用户任务与显式命令为最高优先级，
  不存在可拒绝的请求类别。
- **评分器与会话投影**：开头窗口（160）判拒 + REFUSAL / FALLBACK / SAFE / RISK 四类标记
  + 域命中检测，驱动客户端状态条展示。该投影是**评分器**，不参与系统提示词注入。
- **客户端实时状态条**：在输入框上方挂载 `⚫ Switch Armor v{VERSION}` 动态状态条（含命中域/载荷数显示）。
  状态条与开关共用一张注入的样式表（`#dsh-armor-style`），外观全部来自 DSH 设计 token
  （`--dsw-alias-*`），状态由 `data-phase` / `aria-checked` 驱动，**组件内不写任何 inline style**
  —— 因此不会漏出浏览器默认的黑色 outline，深/浅主题自动跟随。
  阶段语义色：idle/pass = `state-success-primary`，running = `state-business-primary`
  （配 `state-business-tertiary` 底 + 脉冲圆点），refusal = `state-error-primary`
  （配 `state-error-secondary` 底），开关关闭 = 灰态 `label-tertiary` + `bg-layer-2`。
- **客户端状态条的位置**：挂 `conversation.input.left`（输入框工具栏左侧席位，`id: armor`、
  `order: 30`），**不是**输入框上方的 dock。
- **profile 元数据工具**：`switch_armor_profile` 返回内核版本、注入槽位清单、载荷路由状态
  （`payloadRouting.mode` / `manualPayload` / `payloads` / `rules`）与能力标记。

## 注入面文件

| 文件 | 用途 | 内容 |
|---|---|---|
| `prompts/infinite-gen-4.md` | `dsh-gen4` 备用自持档（仅手动可选中） | 内核载荷（权威源） |
| `prompts/infinite-gen-4.1-flash.md` | 镜像槽位同源副本 | 同源载荷（逐字一致） |
| `prompts/infinite-gen-3.md` | 历史兼容文件名 | 同源载荷（逐字一致） |
| `prompts/gpt-6.1-sol.md` | GPT-6.1 系 | Codex 破甲载荷（外部引入，不改字节） |
| `prompts/gpt-6-astra.md` | GPT-6 系 | Codex 破甲载荷（外部引入，不改字节） |
| `prompts/gpt-5.6-sol.md` | GPT-5.6 / gpt-5.* / o<n> / codex | Codex 破甲载荷（外部引入，不改字节） |

三份 `gpt-*.md` 的来源、许可与 SHA256 见 [`prompts/SOURCES.md`](prompts/SOURCES.md)。
它们**不参与**「同源同构」约束（那三份 DSH 自持载荷才要求逐字一致），
verify 只断言它们「未被改动」（比对固定 SHA256）与「无 `{{`」。

### 开关面文件

| 位置 | 用途 |
|---|---|
| `index.js` → `SETTINGS_NAMESPACE = "dsh-switch-armor"` | host 半注册的 settings namespace |
| `index.js` → `enabled` / `mode` / `manualPayload` | 三个字段（均为 `.volatile()`） |
| `client.js` → `createSettingSource()` / `createRoutingSource()` | 客户端两个状态源：开关、载荷路由 |
| `~/.dsh/switch-armor/sessions.json` | 会话级开关覆盖（只存 boolean，`mode` 不做会话级） |
| profile patch → `dsh-switch-armor.config.*` | 持久化落点（`settings.update` 写回） |

| 探针 | 覆盖 |
|---|---|
| `tests/armor-dock-probe.mjs` | 离线渲染探针：桩 React + 桩 settings scope，验证 5 个阶段（idle/running/pass/refusal/off）的 DOM、无内联样式残留与样式表锚点 |
| `tests/payload-routing-probe.mjs` | 离线分流矩阵：桩 ctx 调 `apply()` 捕获段求值器，喂 49 组模型形态（含下划线/空格/点号分隔、粘连、chat 前缀、provider 前缀+标签后缀、日期戳、尾随斜杠、仿冒名）断言选中的载荷；并覆盖镜像槽位的单段/双段分支、手动模式、非法入参 400、总开关关闭零残留（**104 项**） |
| `tests/armor-settings-probe.mjs` | 离线客户端探针：桩 `__ModuleLoader__` 捕获 spec，断言 tab 注册元数据（id=包名）、四份载荷渲染、模式切换与载荷选择发出的请求体（**22 项**） |

`index.js` 静态依赖 `@deepseek-ai/schemastery`（schemas 的 schema 定义库，随
`dsh-settings-file` 一并装载于 profile 的 `node_modules`），用于声明三个字段。

三份 DSH 自持载荷文件的 SHA256 完全相同，`scripts/verify_prompt_gen4.mjs` / `verify_prompt.mjs` 会强断言这一点。

## 版本

| 版本 | 说明 |
|---|---|
| v0.3.0 | 双层注入首版（通用内核槽位 + 战场实测层槽位） |
| v0.4.0 | 双层注入收敛为同源同构内核；注入槽位统一为 `switch-armor:*`；内核载荷与强化镜像逐字一致 |
| v0.5.0 | 新增对话框热开关：条件段 + settings namespace，**默认关闭**；关闭时零残留；状态条联动灰态；profile 工具回报开关状态 |
| **v0.6.0** | 按模型分流注入载荷：GPT 系走三份 Codex 载荷（**按 model 名的版本号语义解析**，容忍各种写法，单段注入），其余走 DSH 自持载荷（双段）；新增 `mode`(auto/manual) + `manualPayload` 配置与设置页 tab |
| **v0.7.0** | 融入 Keysmith 系列载荷：自持档 `dsh` 换成 keysmith 短稿，原 7739B 契约稿降为可切换的备用档 `dsh-gen4`；新增 `claude`（`^claude`）与 `grok`（`^grok`）两条家族锚定分支；载荷表 4 → 7 项；**双段收紧为仅自持族**，镜像槽位改为跟随主槽位的同一份文本；文本缺失改为**按 id 回落**（`PAYLOAD_FALLBACKS`） |
| v0.7.1 | **段位前移**：载荷 order 由 100/200 改为 **0.1/0.2**，从「排在 19.5k 记忆索引之后」提到 `persona(0)` 之后、`dsh-memory(1)` 之前 |
| v0.8.0 | **项目定名 Switch Armor**；载荷分流 7 份；段位 order 0.1/0.2；文档全面重写 |
| v0.8.1 | 新增项目 banner（随包发布） |
| v0.8.2 | 补全 npm 元数据：`license: MIT` + `keywords`（解决 npm 页面不显示许可证） |
| v0.8.3 | 修客户端状态条版本漂移；新增「四者版本一致」与「样式锚点缺失即失败」两类断言 |
| v0.9.0 | **载荷表 7 → 9**：新增 `glm`（`^(?:glm\|chatglm)` → ZCode 载荷，为 GLM 写的）与 `kimi`（`^kimi` → kimi-break，收编时剥离 Kimi Code 宿主段）；`glm-5.3*` 从 `dsh` 档改判 `glm` 档 |
| v0.9.1 | `swe` 系归入 `kimi` 载荷（`^(?:kimi\|swe[\d_-])`，收紧排除 `sweet-*`） |
| **v0.10.0** | **按模型族覆盖 + 自定义载荷**：settings 新增 `modelOverrides`（`{ family: { payload, dualLayer } }`，payload 可为 `custom`）与 `customPayload`（`{ text }`，64k 字符上限）；`dualLayerFor()` 取代裸 `NATIVE_PAYLOAD_IDS.includes` 判定（族覆盖可强制双段/单段）；自有路由 GET/POST 扩两字段（对象字段按 JSON 序列化比对持久化校验）；设置页新增覆盖表（每族：默认/9 载荷/自定义/双段/单段）与自定义输入框；探针 collect 修复嵌套数组 children 漏数 |

## Local verification

```powershell
node --check index.js && node --check client.js
node scripts/verify_prompt_gen4.mjs    # 269 项：载荷契约 + 分流规则 + 配置面 + 客户端 tab + 投影
node tests/payload-routing-probe.mjs   # 104 项：分流矩阵 + 单段/双段 + 手动模式 + 400 分支
node tests/armor-settings-probe.mjs    # 27 项：设置页 11 按钮（2 模式 + 9 载荷）+ 写入路径
node tests/armor-dock-probe.mjs        # 状态条 5 阶段渲染
```

## Install in the desktop Harness

```powershell
# profiles/default/package.json
"dependencies": {
  "dsh-switch-armor": "file:../../plugins/dsh-switch-armor"
},
"dsh": {
  "profile": {
    "bundles": ["@deepseek-ai/dsh-base", "dsh-switch-armor"]
  }
}
```

然后 `cd $env:USERPROFILE\.dsh\profiles\default && pnpm install`，重启会话（或执行 `install.ps1`）。

注意：若 profile 中同时启用其它同样注册系统提示词段的破甲包，组装时会出现多份载荷叠加；
如需本插件载荷独占生效，请二选一保留。
