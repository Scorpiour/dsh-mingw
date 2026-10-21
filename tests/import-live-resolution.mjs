/**
 * Dev-only reproduction: import the preset executor through the running
 * profile's runtime resolution, exactly as the Host Loader does.
 */

import { Context } from 'file:///E:/Develop/deepseek-harness/vendor/cordis/lib/index.js'
import Loader from 'file:///E:/Develop/deepseek-harness/vendor/loader/lib/index.js'
import { createRuntimeResolution, loadProfileDirectory, PluginPackages } from 'file:///E:/Develop/deepseek-harness/packages/boot/app-boot/lib/index.js'
import { pathToFileURL } from 'node:url'

const profileDir = 'C:\\Users\\Scorpiour\\.dsh\\profiles\\web'
const installAnchor = 'E:\\Develop\\deepseek-harness\\apps\\cli\\package.json'
const profile = loadProfileDirectory('dsh', profileDir, installAnchor)
const resolution = await createRuntimeResolution({ installAnchor, profile })
console.log('linked roots:', resolution.linkedRoots)
console.log('profile packages:', resolution.entries.filter(entry => entry.scope === 'profile').map(entry => entry.name))

const ctx = new Context()
await ctx.plugin(Loader)
await ctx.plugin(PluginPackages, { resolution })
ctx.baseUrl = pathToFileURL(profileDir).href + '/'
try {
  const ns = await ctx.loader.internal.import('@local/dsh-win-mingw/executor', ctx.baseUrl, {})
  console.log('imported:', Object.keys(ns))
} catch (error) {
  console.error('IMPORT FAILED:')
  console.error(error)
  process.exitCode = 1
}
await ctx.fiber.dispose()
