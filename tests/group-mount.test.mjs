/**
 * Dev-only group-mount test: mount the isolated `shell` group exactly as the
 * preset does, in a fresh process with the profile's runtime resolution.
 *
 * Set DSH_CHECKOUT to locate the DSH source checkout and DSH_PROFILE_DIR (or
 * DSH_HOME / DSH_PROFILE) to select the installed profile when the defaults do
 * not apply.
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveCheckout, resolveInstallAnchor, resolveProfileDir } from '../scripts/dev-paths.mjs'

const checkout = resolveCheckout()
const profileDir = resolveProfileDir()
const installAnchor = resolveInstallAnchor(checkout)
const [{ Context }, { default: Loader }, { default: Group }, { createRuntimeResolution, loadProfileDirectory, PluginPackages }] = await Promise.all([
  import(pathToFileURL(join(checkout, 'vendor/cordis/lib/index.js')).href),
  import(pathToFileURL(join(checkout, 'vendor/loader/lib/index.js')).href),
  import(pathToFileURL(join(checkout, 'vendor/group/lib/index.js')).href),
  import(pathToFileURL(join(checkout, 'packages/boot/app-boot/lib/index.js')).href),
])
console.log('checkout:', checkout)
console.log('profile:', profileDir)
const profile = loadProfileDirectory('dsh', profileDir, installAnchor)
const resolution = await createRuntimeResolution({ installAnchor, profile })

const ctx = new Context()
await ctx.plugin(Loader)
ctx.loader.builtins.group = Group
await ctx.plugin(PluginPackages, { resolution })
ctx.baseUrl = pathToFileURL(profileDir).href + '/'
ctx.provide('subprocess', {})
ctx.provide('sandbox', {})
ctx.provide('sandboxPolicy', { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) })

await ctx.loader.root.update([{
  id: 'shell-mingw',
  name: 'cordis:group',
  group: true,
  isolate: { shell: true },
  config: [{
    id: 'mingw-shell',
    name: '@local/dsh-win-mingw/executor',
    config: {},
  }],
}])

for (const entry of ctx.loader.root.tree.entries()) {
  console.log(entry.options.id, 'fiber=', entry.fiber !== undefined, 'module=', entry.moduleNamespace !== undefined)
  if (entry.fiber !== undefined) await entry.fiber.await()
}
const mounted = [...ctx.loader.root.tree.entries()].find(entry => entry.options.id === 'mingw-shell')
if (mounted?.fiber === undefined) {
  console.error('EXECUTOR ROW NEVER STARTED')
  process.exitCode = 1
} else {
  console.log('executor row active:', mounted.fiber.state)
}
await ctx.fiber.dispose()
