/**
 * MinGW/MSYS bash executor for the `ctx.shell` seam.
 *
 * The stock Windows executor speaks PowerShell; this one keeps the subprocess
 * and sandbox mechanics of `@deepseek-ai/dsh-bash-sandbox` but puts the
 * MinGW64 `bash.exe` bundled with Git for Windows first on the child `PATH`.
 * Every command then runs through `bash -c` with POSIX parsing, UTF-8 bytes,
 * and `$DSH_*` variables, so the model never has to deal with PowerShell
 * quoting, cmdlet interception, or console code pages.
 *
 * The Windows file sandbox cannot start the MSYS runtime at all — its
 * WRITE_RESTRICTED, Low-integrity token denies the shared-memory namespace and
 * token-default-DACL setup MSYS performs while loading — so `read-only` and
 * `workspace-write` commands run through the local mechanics instead and carry
 * an explicit unconfined notice. `danger-full-access` keeps the inherited
 * sandbox path. The README's "sandbox modes" section owns the full rationale.
 *
 * The executor is mounted inside an isolated `shell` group by the bundle
 * patch, so it never replaces the host PowerShell executor that existing
 * sessions still use.
 *
 * @module @local/dsh-win-mingw/executor
 */

import z from '@deepseek-ai/schemastery'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { buildBashPath, findPathValue, resolveMingwBash } from './mingw.js'

/** Default per-stream spill cap, matching `@deepseek-ai/dsh-bash-local`. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Default SIGTERM→SIGKILL grace, matching `@deepseek-ai/dsh-bash-local`. */
const DEFAULT_GRACE_MS = 3_000

/** File-policy modes whose Windows backend cannot start Git Bash (see the README). */
const CONFINED_MODES = new Set(['read-only', 'workspace-write'])

/**
 * The per-command stderr notice stamped on a call that had to run outside the
 * file sandbox. Git Bash's MSYS runtime aborts during startup under the ACL
 * sandbox's WRITE_RESTRICTED, Low-integrity token, so a confined mode cannot
 * execute the command at all; running it unconfined keeps the shell usable but
 * must be visible to the model and the user on every call.
 * @param {string} mode the standing file policy the call would have used.
 * @returns the notice line.
 */
function unconfinedNotice(mode) {
  return `[mingw-shell] unconfined: DSH's ${mode} file sandbox cannot start Git Bash; `
    + 'this command ran WITHOUT sandbox confinement.\n'
}

/**
 * Merge the notice into one consuming `readOutput` delta as its first stderr
 * line, preserving the stdout/`[stderr]` section layout the shell contract
 * defines.
 * @param {string} delta the executor's own delta.
 * @param {string} notice the notice line to insert.
 * @returns the delta carrying the notice exactly once.
 */
function withNotice(delta, notice) {
  const marker = '[stderr]\n'
  const index = delta.lastIndexOf(marker)
  if (index >= 0) {
    const at = index + marker.length
    return `${delta.slice(0, at)}${notice}${delta.slice(at)}`
  }
  const separator = delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''
  return `${delta}${separator}[stderr]\n${notice}`
}

/**
 * Present a locally executed process as if the notice were its first stderr
 * bytes. The settled foreground projection, the job pump's observed stream
 * (which `job_output` and promoted reads consume), and the consuming
 * `readOutput` delta all carry it, so no consumer can mistake the command for
 * a confined one.
 *
 * The notice is ASCII, so its byte length equals its character length and the
 * observed reader can shift offsets directly.
 * @template {import('@deepseek-ai/dsh-shell').ShellExecution} T
 * @param {T} execution the live process handle from `executeArgv`.
 * @param {string} mode the policy mode the call would have run under.
 * @returns {T} the same handle, stamped.
 */
function stampUnconfined(execution, mode) {
  const notice = unconfinedNotice(mode)
  const observed = execution.observed.stderr
  execution.observed = {
    ...execution.observed,
    stderr: {
      readFrom(fromByte) {
        if (fromByte >= notice.length) {
          const read = observed.readFrom(fromByte - notice.length)
          return { ...read, nextOffset: read.nextOffset + notice.length }
        }
        const read = observed.readFrom(0)
        return {
          text: notice.slice(fromByte) + read.text,
          nextOffset: read.nextOffset + notice.length,
          lossy: read.lossy,
        }
      },
    },
  }
  const settle = execution.result.bind(execution)
  let settled
  execution.result = () => {
    settled ??= settle().then(result => ({
      ...result,
      stderr: { ...result.stderr, text: notice + result.stderr.text },
    }))
    return settled
  }
  const read = execution.readOutput.bind(execution)
  let noticePending = true
  execution.readOutput = () => {
    const next = read()
    if (!noticePending) return next
    noticePending = false
    return { ...next, delta: withNotice(next.delta, notice) }
  }
  return execution
}

/**
 * Environment values that make tool output deterministic on Windows.
 *
 * `BASH_ENV` is neutralized because a non-interactive bash sources that file
 * before the command, which would let an unrelated file garble output. The
 * Python values pin UTF-8 for the common `python -c` case; Git Bash and
 * MSYS2 already read and write UTF-8 for their own tools.
 */
const DETERMINISTIC_ENV = {
  BASH_ENV: '',
  TERM: 'dumb',
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
}

/**
 * The local bash executor's configuration plus MinGW selection knobs.
 *
 * The first six fields mirror `@deepseek-ai/dsh-bash-local` exactly; the
 * executor inherits that package's mechanics, so the defaults must match.
 */
export const Config = z.object({
  cwd: z.string().volatile(),
  timeoutMs: z.number().default(120_000).volatile(),
  maxTimeoutMs: z.number().default(600_000).volatile(),
  maxOutputBytes: z.number().default(64_000).volatile(),
  maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES).volatile(),
  graceMs: z.number().default(DEFAULT_GRACE_MS).volatile(),
  /**
   * Explicit MinGW/MSYS bash executable. Omitted, the plugin probes Git for
   * Windows and MSYS2 install locations, then `PATH`; `MINGW_BASH` overrides
   * the probed value without reinstalling the bundle.
   */
  bashPath: z.string().volatile(),
  /** Run `uname` once to reject WSL/other shells (default true). */
  verifyBash: z.boolean().default(true),
  /** Extra Windows directories prepended to `PATH`, after the bash directory. */
  pathPrepend: z.array(z.string()).default([]),
  /**
   * Run commands outside DSH's Windows file sandbox when the file policy is
   * `read-only` or `workspace-write` (default true).
   *
   * Git Bash's MSYS runtime aborts while starting under the ACL sandbox's
   * WRITE_RESTRICTED, Low-integrity token: it must create its shared-memory
   * directory in `\BaseNamedObjects` through an absolute NT path and adjust its
   * own token's default DACL, and the confined token permits neither. The
   * sandboxed mode therefore cannot execute any command. With this option on,
   * the command runs through the local executor instead and its stderr starts
   * with an explicit `[mingw-shell] unconfined: ...` notice. Set it to false to
   * keep DSH's confinement; Git Bash commands then fail to start in those modes.
   */
  unconfinedInSandboxedModes: z.boolean().default(true),
})

/**
 * `ctx.shell` provider that runs commands in MinGW bash.
 *
 * Registered in place of the host PowerShell executor only inside the bundle
 * patch's isolated shell group. Deadlines, output caps, environment, and job
 * mechanics are inherited from `SandboxBashExecutor` unchanged; confinement is
 * inherited for `danger-full-access` and bypassed (with a visible notice) for
 * the two modes whose Windows backend cannot start MSYS.
 */
export class MingwBashExecutor extends SandboxBashExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  static Config = Config

  /**
   * Cached resolution and the config values it was derived from.
   *
   * Plain fields, not `#private`: Cordis invokes service methods through a
   * proxy whose receiver is not the class instance, and private-brand checks
   * would reject it.
   */
  resolvedShell
  resolutionKey

  /** The last mode whose unconfined fallback was logged (host terminal notice only). */
  announcedUnconfinedMode

  /**
   * Resolve the bash executable once per distinct configuration, lazily so a
   * missing Git install fails one tool call with a clear message instead of
   * preventing the preset from mounting.
   * @returns {{ path: string, source: string, report?: string }} the resolved shell.
   */
  shellPath() {
    const declared = this.config.bashPath.get()
    const verify = this.config.verifyBash
    const override = process.env.MINGW_BASH
    const key = JSON.stringify([declared ?? null, override ?? null, verify])
    if (this.resolutionKey !== key) {
      this.resolvedShell = resolveMingwBash({
        declared: typeof declared === 'string' ? declared : undefined,
        env: process.env,
        verify,
      })
      this.resolutionKey = key
    }
    return this.resolvedShell
  }

  /**
   * Stamp the MinGW `PATH` and deterministic encoding environment onto the
   * resolved execution spec. The caller's own environment is preserved except
   * for `PATH` (rebuilt) and `BASH_ENV` (neutralized).
   * @param {import('@deepseek-ai/dsh-shell').ShellExecRequest} request
   * @returns {import('@deepseek-ai/dsh-shell').ShellExecSpec}
   */
  resolve(request) {
    const spec = super.resolve(request)
    const shell = this.shellPath()
    const inheritedPath = findPathValue(spec.env) ?? findPathValue(process.env) ?? ''
    const env = {}
    for (const [key, value] of Object.entries(spec.env ?? {})) {
      if (key.toLowerCase() === 'path') continue
      if (key === 'BASH_ENV') continue
      env[key] = value
    }
    env.PATH = buildBashPath(shell.path, this.config.pathPrepend, inheritedPath)
    Object.assign(env, DETERMINISTIC_ENV)
    return { ...spec, env }
  }

  /**
   * Execute one command. `danger-full-access` and a disabled fallback go
   * through the inherited sandboxing executor unchanged. A confined policy
   * with the fallback on runs through the local mechanics instead, because the
   * Windows ACL sandbox cannot start Git Bash at all; the handle is stamped
   * with the unconfined notice on every stream so the exception is never
   * silent.
   * @param {import('@deepseek-ai/dsh-shell').ShellExecSpec} spec
   * @returns {Promise<import('@deepseek-ai/dsh-shell').ShellExecution>}
   */
  async execute(spec) {
    const mode = spec.sandboxPolicy?.mode
    if (!CONFINED_MODES.has(mode) || this.config.unconfinedInSandboxedModes !== true) {
      return super.execute(spec)
    }
    this.announceUnconfined(mode)
    const execution = await this.executeArgv(spec, ['bash', '-c', spec.command])
    return stampUnconfined(execution, mode)
  }

  /**
   * State the fallback in the host terminal once per mode, so the reason is
   * discoverable even when no tool result is inspected.
   * @param {string} mode the confined policy mode being bypassed.
   */
  announceUnconfined(mode) {
    if (this.announcedUnconfinedMode === mode) return
    this.announcedUnconfinedMode = mode
    this.ctx.logger?.warn(
      `mingw-shell: Git Bash cannot start inside DSH's Windows file sandbox (${mode}); `
      + 'commands run without sandbox confinement and carry a notice on stderr. '
      + 'Set unconfinedInSandboxedModes: false on the mingw-shell row to enforce the sandbox instead.',
    )
  }
}

export default MingwBashExecutor
