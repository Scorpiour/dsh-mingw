/**
 * Dev-only group-mount test: mount the isolated `shell` group exactly as the
 * preset does, in a fresh process with the profile's runtime resolution.
 */

import { Context } from 'file:///E:/Develop/deepseek-harness/vendor/cordis/lib/index.js'
import Loader from 'file:///E:/Develop/deepseek-harness/vendor/loader/lib/index.js'
import Group from 'file:///E:/Develop/deepseek-harness/vendor/group/lib/index.js'
import { createRuntimeResolution, loadProfileDirectory, PluginPackages } from 'file:///E:/Develop/deepseek-harness/packages/boot/app-boot/lib/index.js'
import { pathToFileURL } from 'node:url'

const profileDir = 'C:\\Users\\Scorpiour\\.dsh\\profiles\\web'
const installAnchor = 'E:\\Develop\\deepseek-harness\\apps\\cli\\package.json'
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
