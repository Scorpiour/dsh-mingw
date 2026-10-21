/**
 * Dev-only executor test: mount the real subprocess, sandbox, policy, and
 * MinGW executor services in a bare Cordis context and run one command.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'

register(new URL('./resolve-hook.mjs', import.meta.url))

const { Context } = await import('@deepseek-ai/cordis')
const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
const { default: LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { default: SandboxPolicyService } = await import('@deepseek-ai/dsh-sandbox-policy')
const { default: MingwBashExecutor } = await import('../index.js')

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(LocalSandboxProvider)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SandboxPolicyService, { mode: 'danger-full-access', workspaceRoot: process.cwd() })
console.log('services:', Boolean(ctx.get('subprocess')), Boolean(ctx.get('sandbox')), Boolean(ctx.get('sandboxPolicy')))
await ctx.plugin(MingwBashExecutor, {})
console.log('shell service:', Boolean(ctx.get('shell')))

const command = [
  'uname -o',
  'pwd',
  `printf 'unicode: 中文-é\\n'`,
  `printf 'probe: %s\\n' "$DSH_PROBE"`,
  'command -v bash',
].join('\n')

const spec = ctx.shell.resolve({
  command,
  workdir: process.cwd(),
  dshEnv: { DSH_PROBE: '中文-值', DSH_SHELL: '1' },
})
const execution = await ctx.shell.execute(spec)
const result = await execution.result()

assert.equal(result.exitCode, 0)
assert.equal(result.timedOut, false)
assert.equal(result.aborted, false)
assert.match(result.stdout.text, /^Msys$/mu)
assert.match(result.stdout.text, /unicode: 中文-é/u)
assert.match(result.stdout.text, /probe: 中文-值/u)
assert.match(result.stdout.text, /\/usr\/bin\/bash|\/bin\/bash/u)

console.log('--- stdout ---')
console.log(result.stdout.text)
console.log('--- stderr ---')
console.log(result.stderr.text)
console.log('--- spec env keys ---')
console.log(Object.keys(spec.env ?? {}).sort().join(', '))
console.log('--- PATH head ---')
console.log((spec.env?.PATH ?? '').split(';').slice(0, 3).join(' | '))

// A working directory with spaces and non-ASCII characters must survive the
// Windows -> MSYS path translation.
const unicodeDir = mkdtempSync(join(tmpdir(), 'dsh mingw 中文-'))
try {
  const cwdSpec = ctx.shell.resolve({ command: 'pwd', workdir: unicodeDir, dshEnv: { DSH_SHELL: '1' } })
  const cwdResult = await (await ctx.shell.execute(cwdSpec)).result()
  assert.equal(cwdResult.exitCode, 0)
  assert.match(cwdResult.stdout.text, /dsh mingw 中文-/u)
  console.log('unicode workdir:', cwdResult.stdout.text.trim())
} finally {
  rmSync(unicodeDir, { recursive: true, force: true })
}

await ctx.fiber.dispose()
console.log('executor integration ok')
