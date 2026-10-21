import assert from 'node:assert/strict'
import { buildBashPath, findPathValue, resolveMingwBash, splitWindowsPath, verifyMingwBash } from '../mingw.js'

const shell = resolveMingwBash({ env: process.env, verify: true })
assert.match(shell.path.toLowerCase(), /bash\.exe$/u)
assert.match(shell.report, /Msys|MINGW|MSYS/iu)
console.log('resolved:', shell.path, `(${shell.source})`)
console.log('report:', JSON.stringify(shell.report))

// Git for Windows installed outside the well-known Program Files locations:
// `git --exec-path` still leads to its bundled MinGW64 bash.
const gitOnly = {
  SystemRoot: process.env.SystemRoot,
  PATH: 'C:\\Program Files\\Git\\cmd',
}
const viaGit = resolveMingwBash({ env: gitOnly, verify: true })
assert.equal(viaGit.source, 'git')
assert.match(viaGit.path, /Git\\bin\\bash\.exe$/iu)
console.log('resolved via git --exec-path:', viaGit.path)

const report = verifyMingwBash(shell.path)
assert.match(report, /Msys|MINGW|MSYS/iu)

const viaDirectory = resolveMingwBash({ declared: 'C:\\Program Files\\Git\\bin', env: process.env, verify: true })
assert.equal(viaDirectory.path, shell.path)
const viaEnvironment = resolveMingwBash({
  env: { ...process.env, MINGW_BASH: 'C:\\Program Files\\Git\\bin\\bash.exe' },
  verify: true,
})
assert.equal(viaEnvironment.source, 'MINGW_BASH')
assert.equal(viaEnvironment.path, shell.path)
console.log('declared directory and MINGW_BASH override ok')

const inherited = 'C:\\Windows\\System32;C:\\Program Files\\Git\\bin;C:\\Windows\\System32'
const path = buildBashPath(shell.path, ['C:\\msys64\\mingw64\\bin'], inherited)
const entries = path.split(';')
assert.equal(entries[0].toLowerCase(), 'c:\\program files\\git\\bin')
assert.equal(entries[1], 'C:\\msys64\\mingw64\\bin')
assert.equal(entries.filter(entry => entry.toLowerCase() === 'c:\\windows\\system32').length, 1)
console.log('path:', path)

assert.deepEqual(splitWindowsPath('"C:\\a;b";C:\\c'), ['C:\\a;b', 'C:\\c'])
assert.equal(findPathValue({ Path: 'x' }), 'x')
assert.equal(findPathValue({ PATH: 'y' }), 'y')
assert.equal(findPathValue({}), undefined)

assert.throws(() => resolveMingwBash({ declared: 'C:\\does\\not\\exist\\bash.exe', env: process.env }), /missing/u)
console.log('mingw resolution ok')
