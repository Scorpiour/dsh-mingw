/**
 * First-pass shell compatibility benchmark: Git Bash vs PowerShell.
 *
 * Each case is a Linux-style command handed unchanged to both shells. The
 * runner records first-attempt success, the model-visible stdout/stderr size,
 * and an output-token estimate. It does not call a model, so the token number
 * is a proxy, not provider billing usage.
 *
 * Run:
 *   node benchmarks/compare-shells.mjs
 *   node benchmarks/compare-shells.mjs --json
 *   node benchmarks/compare-shells.mjs --timeout=15000
 *
 * @module dsh-win-mingw/benchmarks/compare-shells
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { buildBashPath, resolveMingwBash } from '../mingw.js'
import { CASES, createFixture } from './cases.mjs'

/** DSH's fixed context-estimation density; not a provider tokenizer. */
const CHARS_PER_TOKEN = 4

/** Per-block structural overhead used by DSH's token estimate. */
const BLOCK_OVERHEAD = 4

/** Mirrors the UTF-8 setup the old DSH pwsh executor prepends to every command. */
const POWERSHELL_ENCODING_PREAMBLE = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

const HELP = `Usage: node benchmarks/compare-shells.mjs [options]

Options:
  --json             Print machine-readable JSON instead of Markdown.
  --timeout=<ms>     Per-command timeout (default: 10000).
  --help             Show this help.

Environment:
  PWSH_PATH          Explicit PowerShell executable. By default the benchmark
                     probes PowerShell 7, then pwsh on PATH, then Windows
                     PowerShell 5.1 (the old DSH executor's fallback).
  DSH_CHECKOUT       Not used by this benchmark.
`

/** Approximate model-visible tokens using DSH's own 4-chars-per-token heuristic. */
export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** Find the Git installation root by walking up from the selected bash. */
function findGitRoot(bashPath) {
  let directory = dirname(bashPath)
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(directory, 'cmd', 'git.exe'))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * Find the runtime root whose directories the plugin adds to bash's PATH.
 * Git for Windows has a `cmd/git.exe` marker. MSYS2 keeps git under `usr/bin`,
 * so fall back to the `C:\msys64` root inferred from `usr/bin`.
 */
function findRuntimeRoot(bashPath) {
  const gitRoot = findGitRoot(bashPath)
  if (gitRoot !== undefined) return gitRoot
  const bashDirectory = resolve(dirname(bashPath))
  if (basename(bashDirectory).toLowerCase() === 'bin') {
    const parent = dirname(bashDirectory)
    if (basename(parent).toLowerCase() === 'usr') return dirname(parent)
  }
  return bashDirectory
}

/** Resolve the PowerShell executable the old Windows executor would have used. */
function resolvePowerShell() {
  const explicit = process.env.PWSH_PATH?.trim()
  if (explicit !== undefined && explicit.length > 0) {
    if (!existsSync(explicit)) throw new Error(`PWSH_PATH does not exist: ${explicit}`)
    return explicit
  }

  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const powershell7 = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  if (existsSync(powershell7)) return powershell7

  const probe = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  if (probe.error === undefined && probe.status === 0) return 'pwsh'

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const windowsPowerShell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(windowsPowerShell)) return windowsPowerShell

  throw new Error('No PowerShell executable found. Set PWSH_PATH.')
}

/** Run one tiny version probe. */
function executableVersion(executable, args, env) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env,
    timeout: 10_000,
    windowsHide: true,
  })
  return (result.stdout ?? '').trim() || (result.stderr ?? '').trim() || 'unknown'
}

/**
 * Build the PowerShell PATH without the Git/MSYS runtime directories the
 * MinGW plugin adds. The old PowerShell host would not normally have
 * `Git\usr\bin` or `Git\mingw64\bin` on PATH; leaving them in would let
 * PowerShell accidentally pass by invoking the very tools under comparison.
 */
function sanitizedPowerShellPath(bashPath) {
  const inherited = process.env.PATH ?? ''
  const gitRoot = findGitRoot(bashPath)
  const runtimeRoot = findRuntimeRoot(bashPath)
  const entries = []

  for (const raw of inherited.split(';')) {
    const entry = raw.trim().replace(/^"(.*)"$/u, '$1')
    if (entry.length === 0) continue
    const root = resolve(runtimeRoot).toLowerCase()
    const candidate = resolve(entry).toLowerCase()
    if (candidate === root || candidate.startsWith(`${root}${sep}`)) continue
    entries.push(entry)
  }

  // Keep git.exe available for the cross-shell control case, but nothing else
  // from the Git installation.
  if (gitRoot !== undefined && existsSync(join(gitRoot, 'cmd'))) entries.push(join(gitRoot, 'cmd'))
  return entries.join(';')
}

/** Median of numbers; returns null for an empty list. */
function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** A short, single-line diagnostic from stdout/stderr. */
function firstDiagnostic(result) {
  if (result.error !== undefined) return `spawn: ${result.error.message}`
  if (result.timedOut) return `timeout after ${result.timeoutMs}ms`
  const stderr = result.stderr.trim().split(/\r?\n/u).find(line => line.trim().length > 0)
  if (stderr !== undefined) return stderr.trim()
  const stdout = result.stdout.trim().split(/\r?\n/u).find(line => line.trim().length > 0)
  return stdout?.trim() ?? 'no output'
}

/** Execute one case in one fresh fixture directory. */
function execute(executable, shell, testCase, timeoutMs, env) {
  const workdir = mkdtempSync(join(tmpdir(), 'dsh-shell-bench-'))
  try {
    createFixture(workdir)
    const started = process.hrtime.bigint()
    const result = shell === 'bash'
      ? spawnSync(executable, ['--noprofile', '--norc', '-c', testCase.command], {
          cwd: workdir,
          env: { ...env, PWD: '' },
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
        })
      : spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${POWERSHELL_ENCODING_PREAMBLE}${testCase.command}`], {
          cwd: workdir,
          env,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
        })
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6
    const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal !== null
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    const exitCode = result.status
    const expected = testCase.expect.every(pattern => pattern.test(stdout))
    const passed = !timedOut && result.error === undefined && exitCode === 0 && expected && stderr.trim().length === 0
    const reason = passed
      ? undefined
      : result.error !== undefined
        ? `spawn: ${result.error.message}`
        : timedOut
          ? 'timeout'
          : exitCode !== 0
            ? `exit ${String(exitCode)}`
            : !expected
              ? 'stdout mismatch'
              : 'stderr output'
    const outputText = `${stdout}\n${stderr}`

    return {
      case: testCase.id,
      area: testCase.area,
      description: testCase.description,
      command: testCase.command,
      shell,
      passed,
      ...(reason === undefined ? {} : { reason }),
      diagnostic: passed ? undefined : firstDiagnostic({
        stdout,
        stderr,
        error: result.error,
        timedOut,
        timeoutMs,
      }),
      exitCode,
      timedOut,
      durationMs,
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
      outputChars: outputText.length,
      outputTokens: estimateTokens(outputText),
      stdout,
      stderr,
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

/** Aggregate run rows for one shell. */
function summarize(runs) {
  const passes = runs.filter(run => run.passed)
  const totalOutputTokens = runs.reduce((sum, run) => sum + run.outputTokens, 0)
  const failedOutputTokens = runs.filter(run => !run.passed).reduce((sum, run) => sum + run.outputTokens, 0)
  return {
    cases: runs.length,
    passes: passes.length,
    failures: runs.length - passes.length,
    passRate: runs.length === 0 ? 0 : passes.length / runs.length,
    outputChars: runs.reduce((sum, run) => sum + run.outputChars, 0),
    outputTokens: totalOutputTokens,
    tokensPerPass: passes.length === 0 ? null : totalOutputTokens / passes.length,
    failedOutputTokens,
    medianDurationMs: median(runs.map(run => run.durationMs)),
  }
}

/** Human-readable shell names for report tables. */
const SHELL_LABELS = {
  bash: 'Git Bash',
  powershell: 'PowerShell',
}

/** Convert one summary into the report table. */
function summaryTable(summaries) {
  const rows = [
    '| Shell | Pass | Pass rate | Output tokens | Tokens / pass | Failed-case tokens | Median ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const [name, summary] of Object.entries(summaries)) {
    const tokensPerPass = summary.tokensPerPass === null ? 'n/a' : summary.tokensPerPass.toFixed(1)
    const medianMs = summary.medianDurationMs === null ? 'n/a' : summary.medianDurationMs.toFixed(0)
    rows.push(
      `| ${SHELL_LABELS[name] ?? name} | ${summary.passes}/${summary.cases} | ${(summary.passRate * 100).toFixed(1)}% | `
      + `${summary.outputTokens} | ${tokensPerPass} | ${summary.failedOutputTokens} | ${medianMs} |`,
    )
  }
  return rows.join('\n')
}

/** Escape a cell for a Markdown table and keep it on one line. */
function cell(value, limit = 140) {
  const text = String(value ?? '').replace(/\r?\n/gu, ' ').replaceAll('|', '\\|').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Render the failure table. */
function failureTable(runs) {
  const failed = runs.filter(run => !run.passed)
  if (failed.length === 0) return 'No failures.'
  const rows = [
    '| Case | Shell | Reason | Diagnostic |',
    '| --- | --- | --- | --- |',
  ]
  for (const run of failed) {
    rows.push(`| ${cell(run.case)} | ${SHELL_LABELS[run.shell] ?? run.shell} | ${cell(run.reason)} | ${cell(run.diagnostic)} |`)
  }
  return rows.join('\n')
}

/** Render a detailed per-case table. */
function caseTable(runs) {
  const byCase = new Map()
  for (const run of runs) {
    const entry = byCase.get(run.case) ?? {}
    entry[run.shell] = run
    byCase.set(run.case, entry)
  }
  const rows = [
    '| Case | Area | Bash | PowerShell | Bash tokens | PowerShell tokens |',
    '| --- | --- | --- | --- | ---: | ---: |',
  ]
  for (const [id, entry] of byCase) {
    const bash = entry.bash
    const powershell = entry.powershell
    rows.push(
      `| ${cell(id)} | ${cell(bash?.area ?? powershell?.area)} | ${bash?.passed ? 'PASS' : 'FAIL'} | `
      + `${powershell?.passed ? 'PASS' : 'FAIL'} | ${bash?.outputTokens ?? '-'} | ${powershell?.outputTokens ?? '-'} |`,
    )
  }
  return rows.join('\n')
}

/** Build the Markdown report. */
function markdown(report) {
  const { environment, summaries, runs } = report
  return `# Shell compatibility baseline

Generated: ${report.generatedAt}

- Git Bash: \`${environment.bash.path}\` (${environment.bash.version})
- PowerShell: \`${environment.powershell.path}\` (${environment.powershell.version})
- Cases: ${environment.cases}; one attempt per case; timeout ${environment.timeoutMs}ms.
- Pass: exit code 0, all expected stdout patterns matched, and empty stderr.
- Tokens: DSH heuristic \`ceil(chars / 4) + 4\` over stdout + stderr. This is a
  model-visible output proxy, not provider billing usage, and excludes the
  command, system prompt, tool call JSON, and re-sent conversation context.
- PowerShell runs with the Git/MSYS runtime directories removed from PATH; the
  old PowerShell host did not have them, and leaving them in would let
  PowerShell pass by invoking Git Bash's own tools.
- Windows PowerShell 5.1 can emit parser errors in its OEM code page. The
  resulting replacement characters are part of the observed output and the
  token estimate, just as they would be for the old executor.

## Summary

${summaryTable(summaries)}

The PowerShell first-attempt token cost is a lower bound: a failed case would
normally trigger at least one more model turn in a real session.

## Failed cases

${failureTable(runs)}

## Case results

${caseTable(runs)}
`
}

/** Parse the small CLI surface without adding a dependency. */
function parseArgs(argv) {
  let json = false
  let timeoutMs = 10_000
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') json = true
    else if (arg === '--help' || arg === '-h') return { help: true }
    else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const raw = arg === '--timeout' ? argv[++index] : arg.slice('--timeout='.length)
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid --timeout: ${String(raw)}`)
      timeoutMs = parsed
    } else {
      throw new Error(`unknown option: ${arg}`)
    }
  }
  return { json, timeoutMs }
}

/** Run every case in both shells and print the report. */
function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(HELP.trimEnd())
    return
  }
  if (process.platform !== 'win32') throw new Error('this benchmark compares Windows shells; run it on Windows')

  const shell = resolveMingwBash({ env: process.env, verify: true })
  const powershellPath = resolvePowerShell()
  const bashPath = shell.path
  const inheritedPath = process.env.PATH ?? ''
  const bashEnv = {
    ...process.env,
    PATH: buildBashPath(bashPath, [], inheritedPath),
    PWD: '',
    TERM: 'dumb',
    NO_COLOR: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
  }
  const powershellEnv = {
    ...process.env,
    PATH: sanitizedPowerShellPath(bashPath),
    NO_COLOR: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
  }

  const bashVersion = executableVersion(bashPath, ['--noprofile', '--norc', '-c', 'printf "%s\\n" "$BASH_VERSION"'], bashEnv)
  const powershellVersion = executableVersion(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], powershellEnv)

  const runs = []
  for (const testCase of CASES) {
    runs.push(execute(bashPath, 'bash', testCase, options.timeoutMs, bashEnv))
    runs.push(execute(powershellPath, 'powershell', testCase, options.timeoutMs, powershellEnv))
  }

  const summaries = {
    bash: summarize(runs.filter(run => run.shell === 'bash')),
    powershell: summarize(runs.filter(run => run.shell === 'powershell')),
  }
  const report = {
    generatedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      cases: CASES.length,
      timeoutMs: options.timeoutMs,
      bash: { path: bashPath, version: bashVersion, source: shell.source },
      powershell: { path: powershellPath, version: powershellVersion },
      powershellPathSample: powershellEnv.PATH.split(';').filter(Boolean).slice(0, 8),
    },
    methodology: {
      pass: 'exit 0 + expected stdout + empty stderr',
      tokenEstimate: 'ceil((stdout.length + stderr.length + 1) / 4) + 4',
      tokenCaveat: 'output proxy only; excludes command, prompt, tool-call JSON, and re-sent context',
    },
    summaries,
    comparisons: {
      passRateDelta: summaries.bash.passRate - summaries.powershell.passRate,
      outputTokenDelta: summaries.powershell.outputTokens - summaries.bash.outputTokens,
    },
    cases: CASES.map(testCase => ({
      id: testCase.id,
      area: testCase.area,
      description: testCase.description,
      command: testCase.command,
      expect: testCase.expect.map(pattern => pattern.source),
    })),
    runs,
  }

  if (options.json) console.log(JSON.stringify(report, null, 2))
  else console.log(markdown(report))
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
}
