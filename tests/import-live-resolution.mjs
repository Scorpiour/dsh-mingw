/**
 * Dev-only reproduction: import the preset executor through the running
 * profile's runtime resolution, exactly as the Host Loader does.
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
const [{ Context }, { default: Loader }, { createRuntimeResolution, loadProfileDirectory, PluginPackages }] = await Promise.all([
  import(pathToFileURL(join(checkout, 'vendor/cordis/lib/index.js')).href),
  import(pathToFileURL(join(checkout, 'vendor/loader/lib/index.js')).href),
  import(pathToFileURL(join(checkout, 'packages/boot/app-boot/lib/index.js')).href),
])
console.log('checkout:', checkout)
console.log('profile:', profileDir)
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
