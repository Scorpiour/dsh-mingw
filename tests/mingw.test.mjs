import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildBashPath, findPathValue, resolveMingwBash, splitWindowsPath, verifyMingwBash } from '../mingw.js'

/** Walk up from the selected bash until a Git for Windows `cmd/git.exe` is found. */
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

const shell = resolveMingwBash({ env: process.env, verify: true })
const bashDirectory = dirname(shell.path)
assert.match(shell.path.toLowerCase(), /bash\.exe$/u)
assert.match(shell.report, /Msys|MINGW|MSYS/iu)
console.log('resolved:', shell.path, `(${shell.source})`)
console.log('report:', JSON.stringify(shell.report))

// Git for Windows installed outside the well-known Program Files locations:
// `git --exec-path` still leads to its bundled MinGW64 bash. Locate the real
// installation from the resolved shell so this test works for custom roots too.
const gitRoot = findGitRoot(shell.path)
if (gitRoot !== undefined) {
  const gitOnly = {
    SystemRoot: process.env.SystemRoot,
    PATH: join(gitRoot, 'cmd'),
  }
  const viaGit = resolveMingwBash({ env: gitOnly, verify: true })
  assert.equal(viaGit.source, 'git')
  assert.equal(viaGit.path.toLowerCase(), shell.path.toLowerCase())
  console.log('resolved via git --exec-path:', viaGit.path)
} else {
  console.log('git --exec-path discovery skipped: no cmd/git.exe above', bashDirectory)
}

const report = verifyMingwBash(shell.path)
assert.match(report, /Msys|MINGW|MSYS/iu)

const viaDirectory = resolveMingwBash({ declared: bashDirectory, env: process.env, verify: true })
assert.equal(viaDirectory.path, shell.path)
const viaEnvironment = resolveMingwBash({
  env: { ...process.env, MINGW_BASH: shell.path },
  verify: true,
})
assert.equal(viaEnvironment.source, 'MINGW_BASH')
assert.equal(viaEnvironment.path, shell.path)
console.log('declared directory and MINGW_BASH override ok')

const prepend = 'C:\\dsh-win-mingw\\test-bin'
const inherited = `C:\\Windows\\System32;${bashDirectory};C:\\Windows\\System32`
const path = buildBashPath(shell.path, [prepend], inherited)
const entries = path.split(';')
assert.equal(entries[0].toLowerCase(), bashDirectory.toLowerCase())
assert.equal(entries[1], prepend)
assert.equal(entries.filter(entry => entry.toLowerCase() === 'c:\\windows\\system32').length, 1)
console.log('path:', path)

assert.deepEqual(splitWindowsPath('"C:\\a;b";C:\\c'), ['C:\\a;b', 'C:\\c'])
assert.equal(findPathValue({ Path: 'x' }), 'x')
assert.equal(findPathValue({ PATH: 'y' }), 'y')
assert.equal(findPathValue({}), undefined)

assert.throws(() => resolveMingwBash({ declared: 'C:\\does\\not\\exist\\bash.exe', env: process.env }), /missing/u)
console.log('mingw resolution ok')
