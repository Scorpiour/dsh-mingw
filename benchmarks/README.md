# Shell compatibility and token baseline

这个 benchmark 用同一组 Linux 风格命令，对 Git Bash 和 PowerShell 做最基本的
首次尝试对比。它回答两个问题：

1. **兼容性**：模型直接写 Linux/bash 命令时，有多少条能一次成功？
2. **输出压力**：成功或失败时，模型实际看到的 stdout/stderr 大约占多少 token？

## 怎么跑

```sh
node benchmarks/compare-shells.mjs
node benchmarks/compare-shells.mjs --json
node benchmarks/compare-shells.mjs --timeout=15000
```

也可以使用 package script：

```sh
npm run benchmark:shells
```

默认自动选择 PowerShell：

1. `C:\Program Files\PowerShell\7\pwsh.exe`
2. PATH 里的 `pwsh`
3. Windows PowerShell 5.1（旧 DSH executor 的 fallback）

可以用 `PWSH_PATH` 显式指定。Git Bash 复用插件的 `resolveMingwBash()`。

## 指标定义

- **Pass@1**：命令退出码为 0、全部期望 stdout 正则命中、stderr 为空。每个用例只
  执行一次，不做重试。
- **Output tokens**：用 DSH 自己的固定估算规则
  `ceil(model-visible chars / 4) + 4` 对 stdout + stderr 计价。不是 provider 的
  tokenizer，也不是账单数字。
- **Tokens / pass**：总输出 token / 通过数，用来同时反映“失败浪费”和“成功所需输出”。
- **Failed-case tokens**：失败用例产生的输出 token。真实会话中失败还会触发下一轮
  assistant/tool 调用，重新发送历史上下文；这里没有计入。
- **Median ms**：包含 shell 启动时间的中位耗时，仅作参考，不是核心指标。

## 公平性控制

- 两边执行**同一条命令字符串**，不把 Linux 命令翻译成 PowerShell 原生写法。
- 每个用例使用全新的 fixture 目录，避免文件状态影响结果。
- PowerShell 使用旧 DSH executor 的调用形状：
  `-NoLogo -NoProfile -NonInteractive -Command <UTF-8 preamble + command>`。
- **关键点**：PowerShell 的 PATH 会移除 Git/MSYS 的 `bin`、`usr/bin`、
  `mingw64/bin` 等目录，只保留 `Git\cmd` 供 `git` 控制用例使用。否则 PowerShell
  会直接调用 Git Bash 自带的 `printf`、`grep`、`sed`，让对比严重失真。
- Git Bash 使用插件的 `buildBashPath()`，即实际 executor 的 PATH 形状。
- 用例中包含 3 个双 shell 控制项（`cat` 带空格路径、`git --version`、`node -e`），
  避免所有用例都只对 bash 有利。

## 当前基线

2026-10-21，Windows 10 19043，Git Bash 5.3.15，Windows PowerShell 5.1：

| Shell | Pass | Pass rate | Output tokens | Tokens / pass | Failed-case tokens | Median ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Git Bash | 25/25 | 100.0% | 185 | 7.4 | 0 | 57 |
| PowerShell 5.1 | 3/25 | 12.0% | 2572 | 857.3 | 2545 | 197 |

PowerShell 的 3 个通过项正是控制项：`cat`、`git`、`node`。其余 22 个 POSIX
用例首次尝试失败。

这组数字的合理结论是：

- 对“模型直接写 Linux 命令”的场景，Git Bash 的兼容性明显更好。
- PowerShell 的失败输出更长，且失败会引发重试；所以真实会话里的 token 差距通常
  比这张首轮表更大，而不是更小。
- 这**不能**单独证明总账单 token 一定更低。Mingw 模式还会增加系统提示、可能的
  工具描述差异，以及成功命令的输出长度差异；要证明净节省，需要下节的真实会话 A/B。

## 已知限制

- 只测首次尝试，不测模型根据错误自动改写命令后的最终成功率。
- Token 是输出代理，不包含 system prompt、tool schema、命令 JSON、历史上下文重发。
- PowerShell 5.1 的 parser/命令错误可能以 OEM 代码页写入 stderr，再被 UTF-8
  解码；报告中出现的乱码是实际模型会看到的字节的结果，却也说明错误文本的 token
  估算受 locale 影响。PowerShell 7 的调用形状相同，但兼容性和输出可能不同。
- 这是 Windows PowerShell 5.1 的结果。当前机器没有 `pwsh` 7，旧 DSH executor
  在此环境也会 fallback 到 5.1；换到安装了 PowerShell 7 的机器应重新跑一遍。

## 下一步：真实 token A/B

要得到“净 token 消耗”而不是代理值，应建立两个临时 profile：

- 旧模式：`pwsh` shell executor，保留原始 preset；
- 新模式：当前 MinGW bundle。

用同一组 prompt、同一模型、同一 reasoning 设置，各跑 N 次，然后从 session 的
provider `usage` 中汇总 `inputTokens + cacheReadTokens + cacheWriteTokens +
outputTokens`，同时记录完成一次任务所需的 turn/tool-call 次数。这个实验会同时
覆盖“兼容性导致的 retry”和“Mingw prompt 的固定开销”。

## 增加用例

编辑 [`cases.mjs`](cases.mjs)，添加：

```js
{
  id: 'unique-id',
  area: 'category',
  description: 'what it proves',
  command: `linux-style command`,
  expect: [/expected/mu],
}
```

`expect` 是正则数组，必须全部命中 stdout。不要为 PowerShell 单独写一套命令；
这个 benchmark 测的就是同一条命令在两个 shell 中的首次表现。
