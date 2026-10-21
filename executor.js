/**
 * MinGW/MSYS bash executor for the `ctx.shell` seam.
 *
 * The stock Windows executor speaks PowerShell; this one keeps the sandbox
 * and subprocess mechanics of `@deepseek-ai/dsh-bash-sandbox` but puts the
 * MinGW64 `bash.exe` bundled with Git for Windows first on the child `PATH`.
 * Every command then runs through `bash -c` with POSIX parsing, UTF-8 bytes,
 * and `$DSH_*` variables, so the model never has to deal with PowerShell
 * quoting, cmdlet interception, or console code pages.
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
})

/**
 * `ctx.shell` provider that runs commands in MinGW bash.
 *
 * Registered in place of the host PowerShell executor only inside the bundle
 * patch's isolated shell group. Confinement, deadlines, output caps, and job
 * mechanics are inherited from `SandboxBashExecutor` unchanged.
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
}

export default MingwBashExecutor
