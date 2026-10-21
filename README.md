# dsh-win-mingw

把 Windows 上 DSH 的默认 shell 工具从 PowerShell 换成 **Git Bash**。

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

在 DSH 里用插件管理器安装本目录：

```text
plugin_manager action=install_bundle target=E:\Develop\dsh-win-mingw
```

或者从 CLI：

```sh
dsh plugin --profile web add E:\Develop\dsh-win-mingw
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

## 配置

执行器行在 `cordis.patch.yml` 的 `mingw-shell` 下，可用字段：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `bashPath` | 自动探测 | 显式指定 `bash.exe`，也可以指定包含 `bash.exe` 的目录 |
| `verifyBash` | `true` | 是否运行 `uname` 验证选中的 shell 是 MinGW/MSYS |
| `pathPrepend` | `[]` | 追加到子进程 `PATH` 的 Windows 目录（位于 bash 目录之后） |

优先级：`bashPath` > `MINGW_BASH` 环境变量 > 常见 Git/MSYS2 安装位置 >
`git --exec-path` 反推的 Git 根目录 > `PATH`。
显式值不可用时会直接报错，不会悄悄换用别的 bash。

`MINGW_BASH` 对每个命令生效，改环境变量不需要重装 bundle。例如 Git 装在非标准位置：

```powershell
$env:MINGW_BASH = 'D:\PortableGit\bin\bash.exe'
```

如果 Git/MSYS 装在非标准位置，或用的是 scoop / 便携版，优先设置 `MINGW_BASH`。

## 它是怎么接进去的

`cordis.patch.yml` 覆盖 `preset-standard`、`preset-ptc` 和 `preset-cordis` 的完整 `config`，
把原来的两行 `tool-bash` / `tool-pwsh` 换成：

- 非 Windows：仍然挂载原来的 `@deepseek-ai/dsh-tool-bash`（宿主 bash executor）；
- Windows：挂载一个 `isolate: { shell: true }` 的 group，里面依次是
  `MingwBashExecutor`、`@deepseek-ai/dsh-tool-bash`、MinGW 提示段。

因为 `shell` 服务被隔离在 group 里，宿主由 `@deepseek-ai/dsh-pwsh-sandbox` 提供的
PowerShell executor 不会被替换。旧会话和 `minimal` 仍然能用原来的 PowerShell
工具，不会因为这次安装而坏掉。

- `executor.js` — `MingwBashExecutor extends SandboxBashExecutor`：只重写 `resolve()`，
  把 `PATH` 改成 Git Bash 目录优先，并固定 `TERM`/`NO_COLOR`/UTF-8/Python 相关变量。
  沙箱、超时、后台 job、输出上限全部继承。preset 行引用 `@local/dsh-win-mingw/executor`
  这个独立入口，避免热更新时复用旧的模块代。
- `index.js` — 包根入口，转发到 `executor.js`。
- `mingw.js` — 探测和验证 bash；也是独立测试的入口。
- `prompt.js` — 一小段系统提示，放在 bash 工具说明之后（order 1005），告诉模型这是
  Git for Windows 自带的 MinGW64 bash，而不是 PowerShell。
- `scripts/build-patch.mjs` — 从 DSH checkout 的 `@deepseek-ai/dsh-web-app` preset 文件
  重新生成 `cordis.patch.yml`。升级 DSH 后重跑：

  ```sh
  node scripts/build-patch.mjs E:\Develop\deepseek-harness
  ```

## 测试

```sh
node --check index.js
node --check executor.js
node --check prompt.js
node --check mingw.js
node tests/mingw.test.mjs
node tests/import.test.mjs
node tests/executor.test.mjs
```

`tests/import.test.mjs` 用 dev-only 的 resolve hook 模拟宿主对 `@deepseek-ai/*` 的
runtime resolution；`tests/executor.test.mjs` 则挂载真实的
`@deepseek-ai/dsh-subprocess-local`、`@deepseek-ai/dsh-sandbox-local`、
`@deepseek-ai/dsh-sandbox-policy` 和本执行器，实际跑一条 `bash -c` 命令，验证
`Msys`、POSIX 路径、UTF-8 中文和 `DSH_*` 注入。`tests/` 和 `scripts/` 不包含在发布用的
`files` 里。

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

- `workspace-write` 模式下，MinGW bash 本身和 Git 的 `/tmp` 与 Windows ACL 私有临时目录
  的组合还没有做端到端验证。当前 profile 默认是 `danger-full-access`；如果切到
  `workspace-write` 后遇到临时文件写入被拒绝，请先切回 `danger-full-access` 或反馈。
- 命令里显式调用 `powershell` / `cmd /c` 时，仍然由它们执行。
- `minimal` preset 保持原样，仍是持久 pwsh。
- 旧会话不会热切换；需要新建会话。
- 如果刚安装后当前进程仍缓存了旧的模块代，重启 DSH 一次即可；新会话会使用
  `@local/dsh-win-mingw/executor` 这个独立入口，不受包根旧缓存影响。
- 依赖 `@deepseek-ai/dsh-bash-sandbox` / `dsh-bash-local` 的当前 API，DSH 升级后先跑
  测试和 `build-patch.mjs`，再安装更新。
