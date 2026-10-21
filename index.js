/**
 * Package root: re-export the MinGW executor.
 *
 * The bundle patch references the dedicated `./executor` entry so a freshly
 * installed revision never reuses an older module generation of the package
 * root; this root entry keeps `@local/dsh-win-mingw` resolvable for tooling and
 * for a future composition that prefers the package name.
 *
 * @module @local/dsh-win-mingw
 */

export * from './executor.js'
export { default } from './executor.js'
