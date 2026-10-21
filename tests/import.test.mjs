/** Dev-only smoke test: the executor module imports and exposes its plugin surface. */

import assert from 'node:assert/strict'
import { register } from 'node:module'

register(new URL('./resolve-hook.mjs', import.meta.url))

const executor = await import('../executor.js')
const root = await import('../index.js')
const prompt = await import('../prompt.js')

assert.equal(typeof executor.default, 'function')
assert.equal(typeof executor.Config, 'function')
assert.equal(executor.default.Config, executor.Config)
assert.equal(root.default, executor.default)
assert.equal(root.Config, executor.Config)
assert.equal(executor.default.inject.includes('sandbox'), true)
assert.equal(typeof prompt.apply, 'function')
assert.deepEqual(prompt.inject, ['systemPrompt'])

console.log('executor import ok:', executor.default.name, executor.default.inject)
console.log('root re-export ok:', root.default === executor.default)
console.log('prompt import ok:', prompt.name, prompt.inject)
