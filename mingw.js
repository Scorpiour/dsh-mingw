/**
 * Locate and verify a MinGW/MSYS bash executable on Windows.
 *
 * This module deliberately has no dependency on the harness: the executor and
 * the standalone tests share it, and resolution must keep working while the
 * plugin's own imports are still being resolved.
 *
 * @module @local/dsh-win-mingw/mingw
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Environment variable that overrides the configured `bashPath` for one host process. */
export const BASH_ENV_OVERRIDE = 'MINGW_BASH'

/** Default per-candidate verification budget. */
const DEFAULT_PROBE_TIMEOUT_MS = 15_000

/** Split a Windows `PATH` value, honoring quoted entries. */
export function splitWindowsPath(value) {
  const entries = []
  let current = ''
  let quoted = false
  for (const character of value) {
    if (character === '"') {
      quoted = !quoted
      continue
    }
    if (character === ';' && !quoted) {
      entries.push(current)
      current = ''
      continue
    }
    current += character
  }
  entries.push(current)
  return entries
}

/** Read the `PATH` entry from an environment map, case-insensitively. */
export function findPathValue(environment) {
  if (environment === undefined || environment === null) return undefined
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === 'path' && typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Whether a path names the Windows Subsystem for Linux launcher. */
function isWslBash(path, environment) {
  const lower = resolve(path).toLowerCase()
  const systemRoot = (environment.SystemRoot ?? environment.windir ?? 'C:\\Windows').toLowerCase()
  if (lower === join(systemRoot, 'system32', 'bash.exe').toLowerCase()) return true
  const localAppData = environment.LOCALAPPDATA
  if (localAppData !== undefined) {
    const windowsApps = join(localAppData, 'Microsoft', 'WindowsApps').toLowerCase() + sep
    if (lower.startsWith(windowsApps)) return true
  }
  return false
}

/** Candidate install roots, most common first. */
function installationRoots(environment) {
  const roots = []
  for (const key of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    const base = environment[key]
    if (typeof base === 'string' && base.length > 0) roots.push(join(base, 'Git'))
  }
  if (typeof environment.LOCALAPPDATA === 'string' && environment.LOCALAPPDATA.length > 0) {
    roots.push(join(environment.LOCALAPPDATA, 'Programs', 'Git'))
  }
  roots.push('C:\\msys64', 'C:\\msys32', 'C:\\tools\\msys64')
  if (typeof environment.USERPROFILE === 'string' && environment.USERPROFILE.length > 0) {
    roots.push(join(environment.USERPROFILE, 'scoop', 'apps', 'git', 'current'))
  }
  return roots
}

/** Expand one installed root into the bash entry points it may provide. */
function rootCandidates(root, source) {
  return [
    { path: join(root, 'bin', 'bash.exe'), source },
    { path: join(root, 'usr', 'bin', 'bash.exe'), source },
  ]
}

/** Expand an explicit `bashPath` (or the environment override) into one candidate. */
function explicitCandidate(value, source) {
  let path = value.trim()
  if (path.length === 0) return []
  if (!isAbsolute(path)) path = resolve(process.cwd(), path)
  try {
    if (statSync(path).isDirectory()) path = join(path, 'bash.exe')
  } catch {
    // A missing path is reported by the attempt list below.
  }
  return [{ path, source }]
}

/** The `PATH` entries that may carry a non-WSL bash. */
function pathCandidates(environment) {
  const candidates = []
  for (const entry of splitWindowsPath(findPathValue(environment) ?? '')) {
    if (entry.trim().length === 0) continue
    candidates.push({ path: join(entry.trim(), 'bash.exe'), source: 'PATH' })
  }
  return candidates
}

/**
 * Ask the `git` on PATH where its exec directory is, then walk up from it.
 *
 * Git for Windows bundles MinGW64 bash (`bin/bash.exe` and `usr/bin/bash.exe`)
 * even when the installation lives outside the well-known Program Files
 * locations; `git --exec-path` is the reliable way to find that root.
 * @param {Record<string, string | undefined>} environment host environment.
 * @returns {{ path: string, source: string }[]} candidate bash paths, nearest root first.
 */
function gitCandidates(environment) {
  const result = spawnSync('git', ['--exec-path'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: environment,
  })
  if (result.error !== undefined || result.status !== 0) return []
  const first = (result.stdout ?? '').trim().split(/\r?\n/u)[0] ?? ''
  if (first.length === 0 || first.startsWith('/')) return []
  const candidates = []
  let directory = resolve(first)
  for (let depth = 0; depth < 5; depth += 1) {
    candidates.push({ path: join(directory, 'bin', 'bash.exe'), source: 'git' })
    candidates.push({ path: join(directory, 'usr', 'bin', 'bash.exe'), source: 'git' })
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return candidates
}

/**
 * Run a resolved bash once and require its kernel to identify as MinGW/MSYS.
 * @param {string} path absolute bash executable.
 * @param {{ timeoutMs?: number }} [options] probe budget.
 * @returns {string} the normalized `uname -s` / `uname -o` report.
 * @throws when the executable cannot run or is a different shell (for example WSL).
 */
export function verifyMingwBash(path, options = {}) {
  if (!existsSync(path)) throw new Error('file does not exist')
  const result = spawnSync(path, ['--noprofile', '--norc', '-c', 'uname -s; uname -o'], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'dumb' },
  })
  if (result.error !== undefined) throw new Error(`cannot run: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split(/\r?\n/u)[0] ?? ''
    throw new Error(`exited ${String(result.status)}${detail.length > 0 ? `: ${detail}` : ''}`)
  }
  const report = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  if (/GNU\/Linux/iu.test(report)) throw new Error('this is WSL bash, not MinGW/MSYS')
  if (!/(?:Msys|MINGW|MSYS)/iu.test(report)) {
    throw new Error(`unexpected uname output: ${report.replace(/\s+/gu, ' ').slice(0, 120)}`)
  }
  return report
}

/**
 * Resolve the bash executable the executor will use.
 *
 * Precedence: the plugin's `bashPath`, then the `MINGW_BASH` environment
 * override, then well-known Git for Windows / MSYS2 installs, then `PATH`.
 * An explicit value is authoritative: when it is unusable the call fails
 * instead of silently selecting another shell.
 *
 * @param {{ declared?: string, env?: Record<string, string | undefined>, verify?: boolean }} [options]
 *   declared path, host environment, and whether to run the MinGW probe.
 * @returns {{ path: string, source: string, report?: string }} the resolved shell.
 * @throws when the platform is not Windows or no usable MinGW/MSYS bash exists.
 */
export function resolveMingwBash(options = {}) {
  const environment = options.env ?? process.env
  const verify = options.verify ?? true
  if (process.platform !== 'win32') {
    throw new Error('mingw-shell: MinGW bash is only available on Windows')
  }

  const declared = typeof options.declared === 'string' ? options.declared.trim() : ''
  const override = typeof environment[BASH_ENV_OVERRIDE] === 'string'
    ? environment[BASH_ENV_OVERRIDE].trim()
    : ''
  const explicit = declared.length > 0
    ? explicitCandidate(declared, 'config')
    : override.length > 0 ? explicitCandidate(override, BASH_ENV_OVERRIDE) : []

  const candidates = []
  if (explicit.length > 0) {
    candidates.push(...explicit)
  } else {
    for (const root of installationRoots(environment)) candidates.push(...rootCandidates(root, 'install'))
    candidates.push(...gitCandidates(environment))
    candidates.push(...pathCandidates(environment))
  }

  const attempts = []
  const seen = new Set()
  for (const candidate of candidates) {
    const path = resolve(candidate.path)
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (!existsSync(path)) {
      attempts.push(`${path} (missing)`)
      continue
    }
    if (explicit.length === 0 && isWslBash(path, environment)) {
      attempts.push(`${path} (WSL launcher, skipped)`)
      continue
    }
    if (verify) {
      try {
        const report = verifyMingwBash(path)
        return { path, source: candidate.source, report }
      } catch (error) {
        attempts.push(`${path} (${error instanceof Error ? error.message : String(error)})`)
        continue
      }
    }
    return { path, source: candidate.source }
  }

  const tried = attempts.length > 0
    ? attempts.slice(0, 12).map(attempt => `  - ${attempt}`).join('\n')
    : '  - no candidate paths were found'
  throw new Error(
    'mingw-shell: no usable MinGW/MSYS bash was found.\n'
    + `${tried}\n`
    + 'Git for Windows already bundles a MinGW64 bash; install Git for Windows '
    + '(or MSYS2), set MINGW_BASH to its bash.exe, or configure bashPath on the '
    + 'mingw-shell row.',
  )
}

/**
 * Build the child `PATH`: the resolved bash directory first (so a bare `bash`
 * starts the MinGW one instead of the WSL launcher), then configured prepends,
 * then the inherited value.
 * @param {string} bashPath absolute MinGW bash executable.
 * @param {readonly string[]} [prepend] extra Windows directories.
 * @param {string} [inherited] existing `PATH` value.
 * @returns {string} the joined, case-insensitively deduplicated `PATH`.
 */
export function buildBashPath(bashPath, prepend = [], inherited = '') {
  const directories = [dirname(bashPath), ...prepend, ...splitWindowsPath(inherited)]
  const seen = new Set()
  const kept = []
  for (const raw of directories) {
    const directory = String(raw).trim().replace(/^"(.*)"$/u, '$1')
    if (directory.length === 0) continue
    const key = directory.replaceAll('/', '\\').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(directory)
  }
  return kept.join(';')
}
