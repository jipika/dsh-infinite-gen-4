# GPT 系载荷来源与许可

本目录下三份 `gpt-*.md` 是从第三方仓库引入的 Codex 破甲提示词，**原样保留字节**，
不参与 `infinite-gen-4.md` / `infinite-gen-4.1-flash.md` 的「逐字同源」约束
（那两份是本插件自持载荷，这三份是外部载荷）。

## 来源

| 本目录文件 | 上游文件 | SHA256（本机实测 = 上游 README 声明） |
|---|---|---|
| `gpt-6.1-sol.md` | `gpt-6.1-sol-v1-rc2.zip` 内的 `gpt-6.1-sol-v1-rc2.md` | `37382fb7082652e5b18c99fa5086fbc6d414993eaeae2ec7852ba372b031acac` |
| `gpt-6-astra.md` | `gpt-6-astra-v2-rc1.zip` 内的 `gpt-6-astra-v2-rc1.md` | `d6976b90b399b9e11df9430dd3663072288f1d858a4910b1e9d5109b3ae7e660` |
| `gpt-5.6-sol.md` | `gpt-5.6-sol-v45.zip` 内的 `gpt-5.6-sol-unrestricted-v45.md` | `c71c50e2f7a303b5eebc2b24c0b1ca0d9c753e3240db05c3e472c679907898f7` |

- 仓库：<https://github.com/MDX-Tom/gpt-instruct>
- 许可：MIT（见该仓库 LICENSE）
- 引入日期：2026-10-09
- 上游 zip 的 SHA256 与上游 README 声明逐字符一致（引入时已校验）

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
- 上游 README 自述：使用自定义模型指令存在账号风险，建议在一次性账号上使用。
  请自行评估。
