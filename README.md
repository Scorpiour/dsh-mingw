# dsh-win-mingw

把 Windows 上 DSH 的默认 shell 工具从 PowerShell 换成 **Git Bash**。

仓库：<https://github.com/Scorpiour/dsh-mingw>

Git for Windows 本身就自带一套 MinGW64 用户态（`bash`、coreutils、`git`、编译器工具链都在其中），
所以这里**不需要单独安装 MinGW 或 MSYS2**：插件直接用 Git 自带的
`C:\Program Files\Git\bin\bash.exe`，并把它所在的目录放到子进程 `PATH` 最前面。
`uname -s` 会显示 `MINGW64_NT-...`，`uname -o` 是 `Msys`，正是 Git for Windows 内嵌的 MinGW64 环境。

装好之后，新会话里的模型看到的是 `bash` 工具，而不是 `pwsh`。命令通过 `bash -c` 执行，
因此不再经过 PowerShell 的 cmdlet 拦截、`$env:` 变量语法、反引号转义和控制台代码页：

- 引号、反斜杠、`$`、反引号、换行都按 POSIX/bash 规则解析；
- stdout / stderr / 重定向文件都是 UTF-8 字节；
- 托管变量是 `$DSH_HOME`、`$DSH_PROFILE`、`$DSH_PROFILE_DIR`、`$DSH_SESSION_ID`、`$DSH_SHELL`；
- 每次调用仍然是新进程，工作目录、超时、后台 job、输出截断和沙箱行为沿用 DSH 的
  `@deepseek-ai/dsh-bash-sandbox` 机制。

⚠️ **沙箱例外**：Git Bash 的 MSYS 运行时无法在 DSH 的 Windows 文件沙箱（`read-only` /
`workspace-write` 使用的受限令牌）里启动，因此这两种模式下命令改为**不受文件沙箱约束**
地执行，并在 stderr 顶部留下 `[mingw-shell] unconfined: ...` 提示。`danger-full-access`
不受影响。原因、行为和关闭方式见[沙箱模式](#沙箱模式与-unconfined-回退)。

## 安装前提

- Windows。
- Git for Windows（默认 `C:\Program Files\Git`）。Git 自带的 MinGW64 bash 就是目标 shell；
  不需要 `C:\msys64`，也不需要把 `bash` 加到系统 PATH。
- DSH `0.2.1-rc.2` 系列（`engines.dsh` 限定在 `>=0.2.1-rc.2 <0.3.0`）。

自动探测顺序：常见 Git 安装目录 → `git --exec-path` 反推出的 Git 根目录 → `PATH` 里的
`bash.exe`。最后一种会跳过 `C:\Windows\System32\bash.exe`（WSL 启动器），并运行一次
`uname -s; uname -o` 确认选中的确实是 MinGW/MSYS；便携版 Git、scoop、非标准目录都能通过
`git --exec-path` 或 `MINGW_BASH` 找到。

## 安装

### 从 GitHub 安装（推荐）

在 DSH 的插件管理器里：

```text
plugin_manager action=install_bundle target=github:Scorpiour/dsh-mingw
```

或者从 CLI：

```sh
dsh plugin --profile web add github:Scorpiour/dsh-mingw
```

需要固定发布版本时使用 tag：

```sh
dsh plugin --profile web add github:Scorpiour/dsh-mingw#v0.1.1
```

### 从本地目录安装（开发）

在克隆目录或源码目录中直接安装：

```text
plugin_manager action=install_bundle target=<克隆目录>
```

```sh
dsh plugin --profile web add <克隆目录>
```

安装会改写三个 preset 定义（`standard`、`ptc` 和 `cordis`），不动宿主现有的 PowerShell
executor。**现有会话保持原样**；新建会话才会使用 MinGW bash。`minimal` preset（持久
pwsh）未改动。

## 验证

新建一个会话，让模型运行：

```bash
uname -o; pwd; printf '中文\n'; echo "$DSH_PROFILE"
command -v pwsh || echo no-pwsh
command -v bash
```

期望看到：

- `Msys`（不是 `GNU/Linux`）；
- 当前目录的 POSIX 形式，例如 `/e/Develop/dsh-win-mingw`；
- 正常输出 `中文`；
- `DSH_PROFILE` 为当前 profile；
- `pwsh` 不存在；
- `bash` 解析到 Git/MSYS 的路径。

如果当前文件策略是 `read-only` / `workspace-write`，stderr 第一行会是
`[mingw-shell] unconfined: ...`：命令成功执行，但没有经过 DSH 文件沙箱（见
[沙箱模式](#沙箱模式与-unconfined-回退)）。`danger-full-access` 下没有这一行。

## 配置

执行器行在 `cordis.patch.yml` 的 `mingw-shell` 下，可用字段：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `bashPath` | 自动探测 | 显式指定 `bash.exe`，也可以指定包含 `bash.exe` 的目录 |
| `verifyBash` | `true` | 是否运行 `uname` 验证选中的 shell 是 MinGW/MSYS |
| `pathPrepend` | `[]` | 追加到子进程 `PATH` 的 Windows 目录（位于 bash 目录之后） |
| `unconfinedInSandboxedModes` | `true` | `read-only` / `workspace-write` 下不使用 DSH 文件沙箱，改为本地执行并在 stderr 顶部标注 `[mingw-shell] unconfined: ...`；设为 `false` 则保留沙箱，但 Git Bash 在这两种模式下无法启动 |

优先级：`bashPath` > `MINGW_BASH` 环境变量 > 常见 Git/MSYS2 安装位置 >
`git --exec-path` 反推的 Git 根目录 > `PATH`。
显式值不可用时会直接报错，不会悄悄换用别的 bash。

`MINGW_BASH` 对每个命令生效，改环境变量不需要重装 bundle。例如 Git 装在非标准位置：

```powershell
$env:MINGW_BASH = 'D:\PortableGit\bin\bash.exe'
```

如果 Git/MSYS 装在非标准位置，或用的是 scoop / 便携版，优先设置 `MINGW_BASH`。

## 沙箱模式与 unconfined 回退

DSH 在 Windows 上的文件沙箱由 `@deepseek-ai/dsh-sandbox-windows-acl` 提供：它把子进程
放进 `WRITE_RESTRICTED` 受限令牌并降到 Low 完整性级别，再把工作区 / 临时目录的写权限用
能力 SID 授出去。Git Bash 的 MSYS 运行时**无法在这种令牌下启动**：

- 它必须在启动早期通过绝对 NT 路径在 `\BaseNamedObjects` 里创建自己的共享内存目录对象
  （`msys-2.0S5-<installation key>`）。`\BaseNamedObjects` 是 Medium 标签，Low
  完整性令牌无法在其中创建（或写入）对象，于是 MSYS 直接
  `fatal error - NtCreateDirectoryObject(...): 0xC0000022`；
- 它还要创建 per-user 共享内存和信号管道，并调整自己进程令牌的 default DACL。受限令牌
  不能让令牌重写 default DACL，restricting SID 的第二次访问检查又会让只写当前用户
  （`S-1-5-21-…`）的对象打不开，于是 `CreateFileMapping S-1-5-21-…-1001.1, Win32 error 5`
  或 `couldn't create signal pipe, Win32 error 5`。

这两个限制来自 Windows 完整性级别和受限令牌本身，不是配置能绕过的；同类问题在其他工具里
也有公开记录（Cursor 官方的回复是沙箱尚未兼容 Git Bash/MSYS2，只能关沙箱）。另外
`workspace-write` 还会先撞上 ACL 授权失败（`windows-acl-run: SetNamedSecurityInfoW
failed (Win32 5): grantWrite(...)`），原因是被授根的目录没有给当前用户 `WRITE_DAC`
（继承自管理员拥有的父目录）。

因此插件默认把受限模式下的 bash 命令**降级**为本地执行（仍然经过 `@deepseek-ai/dsh-subprocess`，
超时、后台 job、输出截断都不变，只是不再经过 Windows ACL 沙箱），并通过三种途径让模型和
用户看见这个例外：

1. 前台结果的 stderr 第一行是
   `[mingw-shell] unconfined: DSH's <mode> file sandbox cannot start Git Bash; this command ran WITHOUT sandbox confinement.`；
2. 后台 job 的输出（`job_output`、超时提升的读取）带同一行；
3. 宿主终端里每个模式记一条 `logger.warn`，说明原因和关闭方式。

`danger-full-access` 不降级，仍走 DSH 原有的沙箱执行路径（该模式下本来就不做限制）。
其他工具（`read` / `write` / `edit` / `fs` 搜索）继续受 `ctx.sandboxPolicy` 约束；只有
`bash` 命令的文件副作用不受约束——提示行就是为了让模型知道这一点，需要受约束的写入请用
`fs` 工具。

要恢复严格的沙箱语义，在 preset 的 `mingw-shell` 行加：

```yaml
- id: mingw-shell
  name: '@local/dsh-win-mingw/executor'
  config:
    unconfinedInSandboxedModes: false
```

此时 `read-only` / `workspace-write` 会直接失败（上面列出的 ACL 授权或 MSYS 启动错误），
需要在需要 bash 时切到 `danger-full-access`。这是 DSH Windows 沙箱与 MSYS 的固有不兼容，
不是插件能单独消除的；如果你希望保留文件沙箱又能跑 Git Bash，只能改 DSH 的沙箱后端
（需要把当前用户 SID 加入 restricting SIDs，会削弱不同工作区之间的写隔离）。

## 它是怎么接进去的

`cordis.patch.yml` 覆盖 `preset-standard`、`preset-ptc` 和 `preset-cordis` 的完整 `config`，
把原来的两行 `tool-bash` / `tool-pwsh` 换成：

- 非 Windows：仍然挂载原来的 `@deepseek-ai/dsh-tool-bash`（宿主 bash executor）；
- Windows：挂载一个 `isolate: { shell: true }` 的 group，里面依次是
  `MingwBashExecutor`、`@deepseek-ai/dsh-tool-bash`、MinGW 提示段。

因为 `shell` 服务被隔离在 group 里，宿主由 `@deepseek-ai/dsh-pwsh-sandbox` 提供的
PowerShell executor 不会被替换。旧会话和 `minimal` 仍然能用原来的 PowerShell
工具，不会因为这次安装而坏掉。

- `executor.js` — `MingwBashExecutor extends SandboxBashExecutor`：重写 `resolve()`，
  把 `PATH` 改成 Git Bash 目录优先，并固定 `TERM`/`NO_COLOR`/UTF-8/Python 相关变量；
  重写 `execute()`，在 `read-only` / `workspace-write` 下改走本地执行器并在 stderr 的
  前台结果、后台 job 观测流和 `readOutput` 增量里各注入一次 unconfined 提示。
  其余沙箱、超时、后台 job、输出上限全部继承。preset 行引用
  `@local/dsh-win-mingw/executor` 这个独立入口，避免热更新时复用旧的模块代。
- `index.js` — 包根入口，转发到 `executor.js`。
- `mingw.js` — 探测和验证 bash；也是独立测试的入口。
- `prompt.js` — 一小段系统提示，放在 bash 工具说明之后（order 1005），告诉模型这是
  Git for Windows 自带的 MinGW64 bash，而不是 PowerShell；受限策略下 bash 的
  unconfined 例外也写在这里。
- `scripts/build-patch.mjs` — 从 DSH checkout 的 `@deepseek-ai/dsh-web-app` preset 文件
  重新生成 `cordis.patch.yml`。升级 DSH 后重跑：

  ```sh
  node scripts/build-patch.mjs
  ```

  默认读取 `DSH_CHECKOUT`，否则自动寻找同级的 `../deepseek-harness`；也可以显式传入
  checkout 路径。脚本共用 `scripts/dev-paths.mjs` 的探测逻辑。

## 测试

```sh
node --check index.js
node --check executor.js
node --check prompt.js
node --check mingw.js
node tests/mingw.test.mjs
node tests/import.test.mjs
node tests/executor.test.mjs
node tests/sandbox-modes.test.mjs
```

`tests/import.test.mjs` 用 dev-only 的 resolve hook 模拟宿主对 `@deepseek-ai/*` 的
runtime resolution；`tests/executor.test.mjs` 则挂载真实的
`@deepseek-ai/dsh-subprocess-local`、`@deepseek-ai/dsh-sandbox-local`、
`@deepseek-ai/dsh-sandbox-policy` 和本执行器，实际跑一条 `bash -c` 命令，验证
`Msys`、POSIX 路径、UTF-8 中文和 `DSH_*` 注入。`tests/sandbox-modes.test.mjs` 覆盖
三种策略：受限模式必须降级成功且前台 / 后台输出都带 unconfined 提示、
`danger-full-access` 保持沙箱路径、`unconfinedInSandboxedModes: false` 时必须经过
`ctx.sandbox`（用假 provider 断言，不碰真实 ACL）。`tests/`、`scripts/` 和
`benchmarks/` 不包含在发布用的 `files` 里。

`tests/import-live-resolution.mjs` 和 `tests/group-mount.test.mjs` 需要真实的 DSH 源码
checkout 和已安装 profile。默认会寻找同级的 `../deepseek-harness`，profile 默认是
`~/.dsh/profiles/web`；也可以用环境变量覆盖。找不到时脚本会直接报出缺失的路径，而不是
静默跳过：

```powershell
$env:DSH_CHECKOUT = 'D:\src\deepseek-harness'
$env:DSH_PROFILE_DIR = "$env:USERPROFILE\.dsh\profiles\web"
node tests/import-live-resolution.mjs
node tests/group-mount.test.mjs
```

`DSH_CHECKOUT` 也用于 `scripts/build-patch.mjs`。

## Shell 兼容性与 token 基线

插件维护了一个最小的双 shell 对比：同一组 Linux 风格命令分别交给 Git Bash 和
PowerShell，统计首次尝试通过率、模型可见输出字节和 token 代理值。

```sh
node benchmarks/compare-shells.mjs
# 或
npm run benchmark:shells
```

2026-10-21 在本机（Git Bash 5.3.15、Windows PowerShell 5.1）的结果：

| Shell | 首次通过 | 输出 token 代理 | 每通过一次的输出 token |
| --- | ---: | ---: | ---: |
| Git Bash | 25/25 | 185 | 7.4 |
| PowerShell 5.1 | 3/25 | 2572 | 857.3 |

PowerShell 的 3 个通过项是 `cat`、`git`、`node` 控制用例。报告中的 token 是
DSH 的 4 字符/token 估算，只覆盖 stdout/stderr，不包含系统提示、工具定义、
命令 JSON 和失败重试导致的历史重发；因此它是首轮输出压力的下界，不等同于真实
账单 token。

完整方法、公平性控制（尤其是 PowerShell PATH 隔离）和真实会话 A/B 方案见
[`benchmarks/README.md`](benchmarks/README.md)。

## 排错：`agent-preset/invalid ... never start`

这个错误表示 Loader 没能导入 preset 里的模块；UI 只显示 audit 的 `never started`，
具体的导入错误在**启动 DSH 的终端**里（Loader 的 `logger.error`）。

最常见原因：DSH 进程在插件文件更新前已经缓存了 `package.json` / 模块代。`./executor`
是后加的导出，旧进程会把它当成不存在的包路径，于是 `mingw-shell` 这一行没有 fiber。

处理：**重启 DSH 一次，不要重装**。然后新建会话。

在一个新进程里验证模块可导入：

```sh
node tests/import-live-resolution.mjs
```

应输出：

```text
imported: [ 'Config', 'MingwBashExecutor', 'default' ]
```

同一个脚本还会打印当前 profile 解析出的 linked root；再用
`node tests/group-mount.test.mjs` 可以验证 `isolate: { shell: true }` 的 group
能正常启动 `mingw-shell` 行。

## 已知限制

- `read-only` / `workspace-write` 下的 bash 命令不再受 DSH 文件沙箱约束（原因见
  [沙箱模式与 unconfined 回退](#沙箱模式与-unconfined-回退)）。命令的 stderr 顶部、
  后台 job 输出和宿主日志都会标注；`read` / `write` / `edit` / `fs` 等工具仍然受
  `ctx.sandboxPolicy` 约束。需要严格沙箱时把 `unconfinedInSandboxedModes` 设为
  `false`，或改用 `danger-full-access`。
- 命令里显式调用 `powershell` / `cmd /c` 时，仍然由它们执行。
- `minimal` preset 保持原样，仍是持久 pwsh。
- 旧会话不会热切换；需要新建会话。
- 如果刚安装后当前进程仍缓存了旧的模块代，重启 DSH 一次即可；新会话会使用
  `@local/dsh-win-mingw/executor` 这个独立入口，不受包根旧缓存影响。
- 依赖 `@deepseek-ai/dsh-bash-sandbox` / `dsh-bash-local` 的当前 API，DSH 升级后先跑
  测试和 `build-patch.mjs`，再安装更新。

## License

MIT，见 [LICENSE](LICENSE)。
