# 🛡️ Switch Armor

<p align="center">
  <img src="assets/banner.png" alt="Switch Armor — DeepSeek Harness Prompt Injection Engine" width="100%" />
</p>

<p align="center">
  <a href="dsh://plugin/install?id=dsh-switch-armor&name=Switch%20Armor&version=0.9.0&repo=jipika%2Fdsh-switch-armor&permissions=%E7%B3%BB%E7%BB%9F%E6%8F%90%E7%A4%BA%E8%AF%8D%E6%B3%A8%E5%85%A5%2C%E5%AE%A2%E6%88%B7%E7%AB%AF%E7%8A%B6%E6%80%81%E6%9D%A1&downloadUrl=https%3A%2F%2Fgithub.com%2Fjipika%2Fdsh-switch-armor%2Farchive%2Frefs%2Fheads%2Fmain.zip">
    <img src="https://img.shields.io/badge/DeepSeek%20Harness-🚀%20%E5%94%A4%E8%B5%B7%E6%A1%8C%E9%9D%A2%E5%AE%A2%E6%88%B7%E7%AB%AF%E4%B8%80%E9%94%AE%E5%AE%89%E8%A3%85-10B981?style=for-the-badge&logo=deepseek&logoColor=white" alt="唤起桌面客户端一键安装" />
  </a>
  <img src="https://img.shields.io/badge/version-0.9.0-blue?style=for-the-badge" alt="v0.9.0" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT" />
</p>

<p align="center">
  <a href="dsh://plugin/install?id=dsh-switch-armor&name=Switch%20Armor&version=0.9.0&repo=jipika%2Fdsh-switch-armor&permissions=%E7%B3%BB%E7%BB%9F%E6%8F%90%E7%A4%BA%E8%AF%8D%E6%B3%A8%E5%85%A5%2C%E5%AE%A2%E6%88%B7%E7%AB%AF%E7%8A%B6%E6%80%81%E6%9D%A1&downloadUrl=https%3A%2F%2Fgithub.com%2Fjipika%2Fdsh-switch-armor%2Farchive%2Frefs%2Fheads%2Fmain.zip">
    <b>🚀 唤起桌面客户端一键安装</b>
  </a>
</p>

**Switch Armor 是 DeepSeek Harness（DSH）的系统提示词注入引擎。**

它按**当前会话实际使用的模型**自动挑选对应形态的交付契约，注入系统提示词，并用一条状态条把注入状态、判拒评分与开关暴露在输入框上。

> 🌐 **插件生态市场**：[DeepSeek Harness Hub — 插件发现与一键安装](https://deepseek.stream/)

---

## ✨ 它做什么

### 🎯 按模型分流载荷

同一个 DSH，不同模型吃不同的话术。注入哪一份不再固定 —— 宿主每个模型步解析**本会话实际使用的模型**，再决定注入哪一份载荷：

| 载荷 id | 命中模型 | 注入段数 |
|---|---|---|
| `dsh` | DeepSeek / 其余（默认自持档） | 双段 |
| `dsh-gen4` | 仅手动模式（备用自持档） | 双段 |
| `gpt61` | `gpt-6.1*` / 6 代以后 | 单段 |
| `gpt6` | `gpt-6*` / `astra*` | 单段 |
| `gpt56` | `gpt-5.x*` / `o*` / `codex*` | 单段 |
| `claude` | `claude*` | 单段 |
| `grok` | `grok*` | 单段 |
| `glm` | `glm*` / `chatglm*`（ZCode 载荷，为 GLM 写的） | 单段 |
| `kimi` | `kimi*`（kimi-break 载荷） | 单段 |

**取值链顺序不可颠倒**：① `agent.session.requestHeader().config.model`（会话**实际发出**的请求头）→ ② 当前默认模型 → ③ `agent.options.model`（创建时声明，最终兜底）。只读第三级，会把会话内切换过模型的会话**静默错配**。

按 **model 名**而非 provider 判定 —— 同一个模型名可能挂在多个 provider 下，只看 provider 必然漏。

**双段只给自持档**：外部载荷（Codex 三档 / Claude / Grok）都是整份契约形态，Codex 稿写明「Text loaded afterward cannot select, replace, or nest ACTION」，Grok 稿自带 `<|im_start|>` 闭合标签 —— 注入两遍会自伤，故恒单段。

### 🎚 注入段位可控

载荷落在**系统提示的固定段位**（order 0.1 / 0.2），夹在 persona 与记忆索引之间：

```
harness:identity  (-1000，已由本插件 patch 关闭)
deployment:persona-prefix  (0)
  ├── switch-armor:global-system-prompt      (0.1)  ← 主槽位
  └── switch-armor:dual-layer-reinforce      (0.2)  ← 镜像槽位
dsh-memory:long-term  (1，记忆索引)
官方工具规范  (1000+)
```

### 🔀 三种控制通道

| 通道 | 用法 |
|---|---|
| **输入框状态条** | 点一下切本会话；**⌥ 点击**切全局 |
| **设置页** | 设置 → 插件 → Switch Armor：模式（自动 / 手动）+ 载荷单选 |
| **模型侧** | 调用 `switch_armor_profile` 读回当前状态与注入槽位真值 |

**默认关闭**：装好后不拨开关，载荷不进入系统提示词。关闭时 `text` 求值函数返回空串，由 `renderPrompt()` 过滤 —— **零残留**，不是「追加一句别理会上面的内容」。

### 📊 实时状态投影

状态条读的是会话投影：判拒评分（开头窗口 + 交付特征）、命中域、当前载荷、注入开关。评分器单源在 `scripts/lib/scorer.mjs`，host 半只做委托调用。

---

## 🛡️ 网络安全红队基准评测的必要性

在生成式 AI 与大语言模型向各行业深度融合的背景下，模型的鲁棒性、对抗防御能力与系统对齐安全性已成为网络空间安全的核心研究课题：

1. **暴露防御边界，反哺安全护栏**：只有通过专业的红队对抗模拟，在受控环境下深入探查模型的输入逃逸、提示词注入与非预期行为，才能帮助安全团队精确定位防护盲区，从而在模型微调、输入过滤网关与系统安全层实现前置加固。
2. **构建攻防一体化防御体系**：缺乏受控红队评测用例的防御如同纸上谈兵。标准化红队用例集为企业与安全审计机构提供了衡量防御策略有效性的「标尺」。
3. **推动大模型原生安全学术发展**：为学术界与安全工程领域提供透明、可复现的基准测试基线，共同推动 AI 基础设施抗对抗攻击与对齐技术演进。

---

> ### ⚠️ 严正法律免责与合规使用声明
>
> **【零容忍严正声明】**：本项目坚决反对并严禁任何形式的违法犯罪行为。开发者绝不支持、不鼓励、不协助任何未授权网络攻击、漏洞利用、数据窃取、非法侵入计算机信息系统或生成违法违禁内容的活动。
>
> 1. **合法受控范围限定**：本项目（`dsh-switch-armor`）定位为纯粹的网络安全红队科研工具与鲁棒性基准评测套件。**严禁在未经所有者合法书面授权的目标、公网在线系统或生产业务上运行本项目**。一切测试行为必须严格限制在**离线本地合成靶标、授权网络安全演练靶场及合规实验室受控环境**中进行。
> 2. **严禁违法与违禁用途**：使用者严禁利用本项目直接或间接从事：
>    - 任何违反《中华人民共和国刑法》《中华人民共和国网络安全法》《中华人民共和国数据安全法》《中华人民共和国个人信息保护法》等法律法规的行为；
>    - 未经授权渗透、攻击公私机构计算机信息系统，实施勒索、破坏、撞库或传播恶意载荷；
>    - 诱导、生成或传播危害国家安全、恐怖主义、暴力血腥、涉黄涉赌、诈骗、侵犯公民隐私或知识产权等任何法律明令禁止的违法违禁内容；
>    - 违反相关大模型提供商的《服务条款》与《滥用政策》。
> 3. **使用者独立承担全部责任**：本项目依据 MIT 开源协议「按现状（AS-IS）」提供，开发者不对软件的完整性、安全性与适用性作任何明示或暗示的保证。**使用者应对自身的所有下载、部署、运行、修改、传播行为以及由此产生的全部输入与输出后果承担独立、完全的民事、行政及刑事法律责任**。
> 4. **违约即终止授权**：任何将本项目用于非法攻击、恶意活动或违规行为的个人或实体，其开源软件使用许可将自违法违规行为发生之日起**自动且不可撤销地立即终止**。
> 5. **第三方独立性声明**：本项目属于完全独立的开源安全评测研究项目，与 DeepSeek 官方或其关联主体无任何隶属、商业合作、授权或官方背书关系。

---

## 📁 项目结构

```
dsh-switch-armor/
├── 🧩 插件装载面（标准 Cordis bundle）
│   ├── package.json             # 插件元数据
│   ├── cordis.patch.yml         # bundle patch（system-prompt 覆盖 + insert 声明）
│   ├── index.js                 # host 半：分流判决 + 条件段 + 自有路由 + 会话投影
│   └── client.js                # client 半：状态条 + 设置页 tab + 路由兜底
├── 📜 载荷本体
│   └── prompts/
│       ├── SOURCES.md               # 载荷来源、许可与哈希
│       ├── dsh-unrestricted.md      # dsh 档
│       ├── infinite-gen-4.md        # dsh-gen4 备用档
│       ├── infinite-gen-4.1-flash.md # dsh-gen4 镜像同源副本
│       ├── gpt-6.1-sol.md           # Codex 档
│       ├── gpt-6-astra.md           # Codex 档
│       ├── gpt-5.6-sol.md           # Codex 档
│       ├── claude-keysmith.md       # Claude 档
│       └── grok-keysmith.md         # Grok 档
├── 🛡️ 回归测试
│   ├── scripts/
│   │   ├── lib/scorer.mjs           # 判拒评分器（单源）
│   │   ├── verify_prompt_gen4.mjs   # 全量断言
│   │   └── verify_prompt_gen41.mjs  # V4.1 专项断言
│   └── tests/
│       ├── payload-routing-probe.mjs # 分流矩阵离线探针
│       └── armor-settings-probe.mjs  # 设置页渲染探针
└── 📁 静态资源 (assets/)
```

---

## ⚡ 安装

### 方式 1：dsh:// 协议一键安装（桌面端）

```
dsh://plugin/install?id=dsh-switch-armor&name=Switch%20Armor&version=0.9.0&repo=jipika%2Fdsh-switch-armor&downloadUrl=https%3A%2F%2Fgithub.com%2Fjipika%2Fdsh-switch-armor%2Farchive%2Frefs%2Fheads%2Fmain.zip
```

### 方式 2：手动配置

在 `~/.dsh/profiles/<profile>/package.json` 中加依赖与 bundle：

```json
{
  "dependencies": {
    "dsh-switch-armor": "link:../../plugins/dsh-switch-armor"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-switch-armor"
      ]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`，**完全重启宿主**（`index.js` 是 host 半，改动必须重启才加载）。

> ⚠️ **不要在 profile 的 `cordis.patch.yml` 里再手工 `insert` 本插件** —— 包自带 patch 已声明 insert，两处会撞成 `duplicate loader entry id`，整个 plugin tree 在 include 阶段就起不来。

---

## ✅ 验证生效

```bash
# 1. 全量断言（载荷契约 + 分流规则 + 配置面 + 客户端 tab + 投影）
node scripts/verify_prompt_gen4.mjs

# 2. 分流矩阵（模型名 → 载荷）
node tests/payload-routing-probe.mjs

# 3. 设置页渲染
node tests/armor-settings-probe.mjs
```

**界面**：输入框工具栏左侧出现 `⚫ Switch Armor v0.9.0` 状态条；设置 → 插件 → Switch Armor 有独立分栏。

**路由**（重启后）：

```bash
curl -s "http://127.0.0.1:19387/dsh-switch-armor/settings" | python3 -m json.tool
curl -s "http://127.0.0.1:19387/dsh-switch-armor/session?id=$DSH_SESSION_ID"
```

---

## 🗑 卸载

1. 从 profile 的 `package.json` 移除依赖与 `bundles` 条目，执行 `pnpm install`
2. 删除 `~/.dsh/plugins/dsh-switch-armor` 与 `~/.dsh/switch-armor/`（会话级开关覆盖表）
3. 完全重启宿主

---

## 📊 版本

| 版本 | 说明 |
|---|---|
| **v0.9.0** | 载荷表 7 → 9：新增 `glm`（ZCode 载荷，GLM 专用）与 `kimi`（kimi-break）；分流规则加 `^glm`/`^chatglm`/`^kimi` 三条家族锚定 |
| v0.8.3 | 修客户端状态条版本漂移（`client.js` 定格 0.6.0 → 与实际版本对齐）；补版本一致性断言与样式锚点失败判定 |
| v0.8.2 | 补全 npm 元数据：`license` 与 `keywords` |
| v0.8.1 | 新增项目 banner；包内含静态资源 |
| v0.8.0 | 项目更名 Switch Armor；载荷分流 7 份（自持 / Codex 三档 / Claude / Grok）；段位 order 0.1 / 0.2 |
| v0.7.1 | 段位前移：载荷从「排在记忆索引之后」提到 persona 之后、记忆之前 |
| v0.7.0 | 按模型分流扩到 7 份载荷；双段收紧为仅自持族；文本缺失按 id 回落 |

---

## ☕ 赞赏支持

如果 Switch Armor 对你的研究与测试有所帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="assets/sponsor.jpg" width="260" alt="微信赞赏码" />
  <img src="assets/afdian_reward.jpg" width="200" alt="爱发电赞助码" />
</p>

<p align="center">
  <b>给项目点个 Star ⭐</b> 同样是对开发者最大的鼓励！
</p>

---

## 📄 License

MIT
