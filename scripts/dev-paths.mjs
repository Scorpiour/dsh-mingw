/**
 * Dev-only path discovery shared by the tests and `build-patch.mjs`.
 *
 * The published bundle never imports this module. Tests that mount the real
 * harness need a DSH source checkout and a profile; requiring users to edit
 * absolute paths would make the repository uncloneable. Prefer explicit
 * environment variables, then a few conventional locations.
 *
 * @module dsh-win-mingw/dev-paths
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, derived from this file's location without relying on cwd. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Files that distinguish a DSH source checkout from an arbitrary directory. */
const CHECKOUT_MARKERS = [
  'apps/cli/package.json',
  'packages/boot/app-boot/lib/index.js',
  'vendor/cordis/lib/index.js',
]

/** Read a non-empty environment path, resolved against the current directory. */
function environmentPath(name) {
  const value = process.env[name]?.trim()
  return value === undefined || value.length === 0 ? undefined : resolve(value)
}

/** Whether a directory contains the layout the dev tests import from. */
export function isDshCheckout(directory) {
  return CHECKOUT_MARKERS.every(marker => existsSync(join(directory, marker)))
}

/**
 * Locate the DSH source checkout used by the live/dev tests.
 *
 * `DSH_CHECKOUT` wins and is validated. Without it, try a sibling checkout
 * (`../deepseek-harness` by default) and a couple of home-directory layouts.
 * @returns {string} absolute checkout root.
 * @throws when no directory has the expected DSH checkout layout.
 */
export function resolveCheckout() {
  const configured = environmentPath('DSH_CHECKOUT')
  if (configured !== undefined) {
    if (!isDshCheckout(configured)) {
      throw new Error(
        `DSH_CHECKOUT does not look like a DSH source checkout: ${configured}\n`
        + 'Expected apps/cli/package.json, packages/boot/app-boot/lib/index.js, and vendor/cordis/lib/index.js.',
      )
    }
    return configured
  }

  const candidates = [
    resolve(repoRoot, '..', 'deepseek-harness'),
    resolve(repoRoot, '..', 'dsh'),
    join(homedir(), 'deepseek-harness'),
    join(homedir(), 'src', 'deepseek-harness'),
  ]
  const found = candidates.find(isDshCheckout)
  if (found !== undefined) return found

  throw new Error(
    'Cannot locate the DSH source checkout used by the dev tests.\n'
    + `Tried: ${candidates.join(', ')}\n`
    + 'Set DSH_CHECKOUT to the checkout root (the directory containing apps/, packages/, and vendor/).',
  )
}

/**
 * Locate the installed DSH profile whose runtime resolution is under test.
 *
 * `DSH_PROFILE_DIR` wins, then `DSH_HOME` (default `~/.dsh`) plus
 * `DSH_PROFILE` (default `web`). The directory must be initialized so failures
 * point at configuration instead of surfacing later as an obscure import error.
 * @returns {string} absolute profile directory.
 * @throws when the resolved profile has no package.json.
 */
export function resolveProfileDir() {
  const configured = environmentPath('DSH_PROFILE_DIR')
  const home = environmentPath('DSH_HOME') ?? join(homedir(), '.dsh')
  const profileName = process.env.DSH_PROFILE?.trim() || 'web'
  const directory = configured ?? join(home, 'profiles', profileName)
  if (!existsSync(join(directory, 'package.json'))) {
    throw new Error(
      `DSH profile not found: ${directory}\n`
      + 'Install the bundle there first, or set DSH_PROFILE_DIR / DSH_HOME / DSH_PROFILE.',
    )
  }
  return directory
}

/** The CLI manifest used as the runtime-resolution install anchor. */
export function resolveInstallAnchor(checkout = resolveCheckout()) {
  return join(checkout, 'apps', 'cli', 'package.json')
}
