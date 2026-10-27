/**
 * Dev-only sandbox-mode test: the confined policies cannot start Git Bash, so
 * the executor must run the command outside the ACL sandbox and say so on
 * every stream, while a disabled fallback keeps the sandboxing path.
 */

import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./resolve-hook.mjs', import.meta.url))

const { Context } = await import('@deepseek-ai/cordis')
const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
const { default: LocalSandboxProvider } = await import('@deepseek-ai/dsh-sandbox-local')
const { default: SandboxProvider } = await import('@deepseek-ai/dsh-sandbox')
const { default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection')
const { default: SandboxPolicyService } = await import('@deepseek-ai/dsh-sandbox-policy')
const { default: MingwBashExecutor } = await import('../index.js')

/** The exact per-command notice the executor stamps on the fallback path. */
const NOTICE = /^\[mingw-shell\] unconfined: DSH's (read-only|workspace-write) file sandbox cannot start Git Bash; this command ran WITHOUT sandbox confinement\.\n/u

/** A sandbox provider that records wraps and runs the argv unchanged, without touching real ACLs. */
class RecordingSandbox extends SandboxProvider {
  calls = []

  async confine(argv, policy) {
    this.calls.push({ argv: [...argv], mode: policy.mode })
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

/**
 * Mount the subprocess, policy, and projection services plus one sandbox
 * provider (real or recording) and the MinGW executor.
 * @param {string} mode the deployment default file policy.
 * @param {{ sandbox?: 'real' | 'recording', executor?: Record<string, unknown> }} [options]
 * @returns {Promise<InstanceType<typeof Context>>} the mounted context.
 */
async function mount(mode, options = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(options.sandbox === 'recording' ? RecordingSandbox : LocalSandboxProvider)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: process.cwd() })
  await ctx.plugin(MingwBashExecutor, options.executor ?? {})
  return ctx
}

// The confined policies must keep the shell usable. The command runs through
// the local executor, and its stderr states the confinement was not applied.
for (const mode of ['read-only', 'workspace-write']) {
  const ctx = await mount(mode)
  const spec = ctx.shell.resolve({
    command: 'uname -o\nprintf "stdout-line\\n"\nprintf "stderr-line\\n" >&2',
    workdir: process.cwd(),
  })
  const result = await (await ctx.shell.execute(spec)).result()
  assert.equal(result.exitCode, 0, `${mode}: ${result.stderr.text}`)
  assert.match(result.stdout.text, /^Msys$/mu)
  assert.match(result.stderr.text, NOTICE, `${mode}: the notice must open stderr`)
  assert.match(result.stderr.text, /stderr-line/u)
  assert.equal(result.sandbox, undefined, `${mode}: no sandbox facts claim confinement`)

  // Background jobs read the observed stream instead of `result()`; the
  // `job_output` contract must see the same notice exactly once.
  const backgroundSpec = ctx.shell.resolve({
    command: 'printf "from-background\\n" >&2',
    workdir: process.cwd(),
    onExpiry: 'none',
  })
  const execution = await ctx.shell.execute(backgroundSpec)
  await execution.done
  const observed = execution.observed.stderr.readFrom(0)
  assert.match(observed.text, NOTICE, `${mode}: the observed stream carries the notice`)
  assert.match(observed.text, /from-background/u)
  // The consuming read the shell contract exposes carries it too, exactly once.
  const read = execution.readOutput()
  assert.equal(read.delta.match(/\[mingw-shell\] unconfined:/gu)?.length, 1, read.delta)
  assert.match(read.delta, /\[stderr\]\n/u)
  await ctx.fiber.dispose()
  console.log(`${mode}: unconfined fallback ok`)
}

// Danger-free access is untouched: the sandbox path reports its facts and no
// notice is stamped.
{
  const ctx = await mount('danger-full-access')
  const spec = ctx.shell.resolve({ command: 'uname -o', workdir: process.cwd() })
  const result = await (await ctx.shell.execute(spec)).result()
  assert.equal(result.exitCode, 0)
  assert.equal(result.sandbox?.mode, 'danger-full-access')
  assert.doesNotMatch(result.stderr.text, /unconfined/u)
  await ctx.fiber.dispose()
  console.log('danger-full-access: sandbox path intact')
}

// Disabling the fallback keeps the sandboxing executor in charge: it wraps the
// argv through `ctx.sandbox` and stamps sandbox facts instead of the notice.
{
  const ctx = await mount('read-only', { sandbox: 'recording', executor: { unconfinedInSandboxedModes: false } })
  const sandbox = ctx.get('sandbox')
  const command = 'uname -o'
  const spec = ctx.shell.resolve({ command, workdir: process.cwd() })
  const result = await (await ctx.shell.execute(spec)).result()
  assert.equal(result.exitCode, 0)
  assert.equal(sandbox.calls.length, 1, 'the confined call must go through ctx.sandbox')
  assert.deepEqual(sandbox.calls[0].argv, ['bash', '-c', command])
  assert.equal(sandbox.calls[0].mode, 'read-only')
  assert.equal(result.sandbox?.mode, 'read-only')
  assert.doesNotMatch(result.stderr.text, /unconfined/u)
  await ctx.fiber.dispose()
  console.log('unconfinedInSandboxedModes=false: sandbox path intact')
}

// The default fallback must not even ask the provider: the ACL sandbox would
// fail while applying the workspace grant or while starting MSYS.
{
  const ctx = await mount('workspace-write', { sandbox: 'recording' })
  const sandbox = ctx.get('sandbox')
  const spec = ctx.shell.resolve({ command: 'uname -o', workdir: process.cwd() })
  const result = await (await ctx.shell.execute(spec)).result()
  assert.equal(result.exitCode, 0)
  assert.equal(sandbox.calls.length, 0, 'the fallback must not wrap the command in the sandbox')
  assert.match(result.stderr.text, NOTICE)
  await ctx.fiber.dispose()
  console.log('workspace-write: no sandbox wrap attempted')
}

console.log('sandbox-mode fallback integration ok')
