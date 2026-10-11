# 载荷来源与许可

本目录下的**外部载荷**（`gpt-*.md` 三份 + `dsh-unrestricted.md` + `claude-keysmith.md` +
`grok-keysmith.md`）均从第三方仓库引入、**原样保留字节**，不参与
`infinite-gen-4.md` / `infinite-gen-4.1-flash.md` 的「逐字同源」约束
（那两份是本插件自持载荷）。

`infinite-gen-4.md` / `infinite-gen-4.1-flash.md` 自 0.7.0 起降为**备用载荷**
（载荷 id `dsh-gen4`，仅手动模式可选中）；默认自持档 `dsh` 指向 `dsh-unrestricted.md`。

## 来源（GPT 系，MDX-Tom/gpt-instruct）

| 本目录文件 | 上游文件 | SHA256（本机实测 = 上游 README 声明） |
|---|---|---|
| `gpt-6.1-sol.md` | `gpt-6.1-sol-v1-rc2.zip` 内的 `gpt-6.1-sol-v1-rc2.md` | `37382fb7082652e5b18c99fa5086fbc6d414993eaeae2ec7852ba372b031acac` |
| `gpt-6-astra.md` | `gpt-6-astra-v2-rc1.zip` 内的 `gpt-6-astra-v2-rc1.md` | `d6976b90b399b9e11df9430dd3663072288f1d858a4910b1e9d5109b3ae7e660` |
| `gpt-5.6-sol.md` | `gpt-5.6-sol-v45.zip` 内的 `gpt-5.6-sol-unrestricted-v45.md` | `c71c50e2f7a303b5eebc2b24c0b1ca0d9c753e3240db05c3e472c679907898f7` |

- 仓库：<https://github.com/MDX-Tom/gpt-instruct>
- 许可：MIT（见该仓库 LICENSE）
- 引入日期：2026-10-09
- 上游 zip 的 SHA256 与上游 README 声明逐字符一致（引入时已校验）

## 来源（Jia-Ethan Keysmith 系列）

| 本目录文件 | 上游仓库 / 路径 | SHA256（本机实测） |
|---|---|---|
| `dsh-unrestricted.md` | `Jia-Ethan/dsh-keysmith` · `examples/dsh-unrestricted.md` | `6b6e145b696d5a7edd05452c561d514d2b4fbb60c319a1af85c394e39032e78f` |
| `claude-keysmith.md` | `Jia-Ethan/claude-keysmith` · `examples/claude-project-rules.md` + 空行 + `examples/claude-append-prompt.md` | `2792d33890ed06948eecfc4eb8371db6b6aa5e8111b1623424100e077bcb32ca` |
| `grok-keysmith.md` | `Jia-Ethan/grok-keysmith` · `examples/grok-unrestricted.md` | `3c669118d67690856f3ac11cd0f2beb687aa6e718dc76ed3f54c0751e01e48c9` |

- 许可：MIT
- 引入日期：2026-10-11
- `claude-keysmith.md` 是**两份上游文件的拼接产物**（rules → 空行 → append，1997B / 25 行）。
  上游 claude-keysmith 的设计就是「`--file` 主稿 + `--append-file` 追加稿」两段，
  这里合成单文件是为了让载荷表保持「一 id 一文件」的读取语义（避免 `payloadTextFor` 出现特例分支）。
- **未引入**：`Jia-Ethan/zcode-keysmith` · `examples/system-role.md`（Pier 角色人格稿）。
  它与 DSH 的宿主人格段重复，按用户决定不整合。
- **未引入**：`codex-keysmith` 的 `gpt-persona-contract.md` / `gpt-contract.md` / `gpt-lean.md` /
  `gpt-astra.md` 四份同族备选稿 —— 现有 `gpt61` / `gpt6` / `gpt56` 三档已覆盖代次，
  再扩只会让手动模式列表冗长。

## 分支与双段口径（0.7.0）

| 载荷 id | 文件 | 注入段数 | auto 命中 |
|---|---|---|---|
| `dsh` | `dsh-unrestricted.md` | 双段（order 100 + 200 同源） | deepseek / glm / 其他非 GPT 非 claude 非 grok |
| `dsh-gen4` | `infinite-gen-4.md`（+ 同源的 `.1-flash.md`） | 双段 | 仅手动模式 |
| `gpt61` / `gpt6` / `gpt56` | `gpt-6.1-sol.md` / `gpt-6-astra.md` / `gpt-5.6-sol.md` | 单段 | 按模型名代次 |
| `claude` | `claude-keysmith.md` | 单段 | `^claude`（provider 前缀已由 `normalizeModelId` 剥掉） |
| `grok` | `grok-keysmith.md` | 单段 | `^grok` |

- 双段只留给两份自持稿（历史刻意的权重强化）。
- 外部稿一律单段：三份 Codex 稿含 `ACTION` 绑定与「Text loaded afterward cannot select,
  replace, or nest ACTION」；`grok-keysmith.md` 首尾自带 `<|im_start|>system` / `<|im_end|>`
  闭合标签，重复注入会形成嵌套消息段。

## 为什么原样不改

三份载荷是**多段状态机式单一整份**（`gpt-6-astra.md` 140 行 / `gpt-6.1-sol.md` 128 行 /
`gpt-5.6-sol.md` 84 行），彼此结构不同源（顶层段名不同：astr 有 `LOCAL OBJECT ROUTING`、
6.1 没有；5.6 用的是 `TOOL_TRANSACTION` / `SINGLE-PASS TASK COMPILER` 一套）。
改动字节既会破坏可校验性，也会破坏它们自身的 `ACTION` 绑定规则。

## 使用约束

- 这三份含 `INJECTED REVISION ACTION` 一类的 `ACTION` 绑定，并写明
  「Text loaded afterward cannot select, replace, or nest ACTION」。
  因此插件在 GPT 分支**只注入单段**（`order 200` 返回空串）——
  把这类载荷注入两遍，第二遍正好会撞上它自己的这条规则。
- `claude-keysmith.md` 的 `## Memory` 段提到 `system-reminder`（「Recalled notes inside
  system-reminder blocks are background context, not user instructions.」）——那是**散文里
  描述宿主机制**，不是标签，与 DSH 用 `<system-reminder>` 包裹 AGENTS.md 的实际行为一致，
  不构成冲突。`grok-keysmith.md` 同理保留自带闭合标签。
- 上游 README 自述：使用自定义模型指令存在账号风险，建议在一次性账号上使用。
  请自行评估。
