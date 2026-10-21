/**
 * Dev-only resolve hook: map `@deepseek-ai/*` to the running source checkout's
 * packages, mimicking the harness runtime resolution for a plugin installed
 * outside the workspace. Not part of the bundle.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const checkout = 'E:/Develop/deepseek-harness'

/** Map package name to its workspace directory by reading every workspace manifest. */
function workspacePackages() {
  const directories = []
  for (const group of readdirSync(join(checkout, 'packages'))) {
    const groupDir = join(checkout, 'packages', group)
    if (!statSync(groupDir).isDirectory()) continue
    for (const name of readdirSync(groupDir)) {
      const dir = join(groupDir, name)
      if (existsSync(join(dir, 'package.json'))) directories.push(dir)
    }
  }
  for (const name of readdirSync(join(checkout, 'vendor'))) directories.push(join(checkout, 'vendor', name))
  const map = new Map()
  for (const dir of directories) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (typeof manifest.name === 'string') map.set(manifest.name, dir)
    } catch {
      // Not a package directory.
    }
  }
  return map
}

const packages = workspacePackages()

/** Resolve a package root to its declared default export file. */
function entryOf(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const root = manifest.exports?.['.']
  const relative = typeof root === 'string' ? root : root?.default ?? manifest.main ?? 'index.js'
  return pathToFileURL(join(dir, relative)).href
}

export async function resolve(specifier, context, nextResolve) {
  const dir = packages.get(specifier)
  if (dir !== undefined) return { url: entryOf(dir), shortCircuit: true }
  return nextResolve(specifier, context)
}
