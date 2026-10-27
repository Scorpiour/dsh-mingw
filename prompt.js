/**
 * Prompt guidance for the MinGW shell preset.
 *
 * The `bash` tool itself is the shipped `@deepseek-ai/dsh-tool-bash`; this
 * section only states the Windows dialect boundary the tool cannot infer:
 * commands are POSIX, paths are Git Bash paths, and `DSH_*` facts use
 * `$NAME` rather than PowerShell's `$env:NAME`. It also states the sandbox
 * boundary: MSYS cannot start under the Windows ACL sandbox, so confined
 * policies run bash unconfined and say so on stderr.
 *
 * @module @local/dsh-win-mingw/prompt
 */

export const name = 'mingw-shell-prompt'

export const inject = ['systemPrompt']

/** One short section placed immediately after the bash tool's own guidance (order 1000). */
const SECTION = `The shell tool on this Windows host runs Git Bash (the MinGW64 shell bundled with Git for Windows), not PowerShell or cmd.exe.
Write POSIX shell commands: use $NAME for variables (not $env:NAME), single or double quotes as in bash, and forward-slash paths.
Windows drives are available under /c, /d, and so on; the working directory is already a POSIX path.
Native Windows programs can still be given C:\\... paths when single-quoted.
Managed harness variables are available as $DSH_HOME, $DSH_PROFILE, $DSH_PROFILE_DIR, $DSH_SESSION_ID, and $DSH_SHELL.
stdout, stderr, and redirected files carry UTF-8 bytes.
Do not wrap a command in powershell -Command or cmd /c unless the task specifically needs a native Windows shell.
Git Bash cannot start inside DSH's Windows file sandbox. When a bash command's stderr begins with "[mingw-shell] unconfined: ...", that command ran WITHOUT sandbox confinement for that reason: do not treat its file effects as confined by the file policy, and use the fs tools when the policy must be enforced.`

/** Register the Windows shell guidance in the preset scope. */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:bash-mingw',
    order: 1005,
    interpolate: false,
    text: SECTION,
  })
}
