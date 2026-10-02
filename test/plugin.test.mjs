import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** Minimal stand-in for the DSH plugin context this plugin actually touches. */
function fakeContext() {
  const listeners = new Map()
  const commands = new Map()
  const warnings = []
  const ctx = {
    on: (event, handler) => listeners.set(event, handler),
    commands: { register: (command) => commands.set(command.name, command) },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { ctx, listeners, commands, warnings }
}

function source(cwd, suffix = 'Your working directory is {{cwd}}.') {
  return {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'deployment:persona-suffix', text: suffix },
    ],
    contexts: [{ name: 'sandbox-policy', text: 'Current DSH file policy: danger-full-access.' }],
    tools: [{ name: 'write', parameters: { required: ['path'], properties: { z: { type: 'string' }, a: { type: 'string' } }, type: 'object' } }],
    variables: { cwd },
  }
}

function events() {
  return [
    { type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 14000, cacheReadTokens: 0 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 1200, cacheReadTokens: 13000 } } },
  ]
}

test('stabilizes through the plugin entry point and reports through /cache', async () => {
  const { ctx, listeners, commands, warnings } = fakeContext()
  apply(ctx, {})

  const assemble = listeners.get('system-prompt/assemble')
  assert.equal(typeof assemble, 'function')

  const input = source('D:/alpha')
  const result = await assemble(input, {}, () => Promise.resolve(input))

  assert.equal(result.sections[1].text, 'Your working directory is provided in the runtime context.')
  assert.deepEqual(result.contexts.at(-1), { name: 'dsh-cache-stabilizer:cwd', text: 'Working directory: {{cwd}}' })
  assert.deepEqual(result.tools[0].parameters, {
    properties: { a: { type: 'string' }, z: { type: 'string' } },
    required: ['path'],
    type: 'object',
  })
  assert.deepEqual(Object.keys(result), Object.keys(input))
  assert.equal(warnings.length, 0)

  const command = commands.get('cache')
  assert.equal(typeof command?.handler, 'function')
  const response = command.handler({ agent: { session: { events: events() } } })
  assert.equal(response.kind, 'success')
  assert.match(response.text, /Cache hit rate: 46\.1% \(cacheRead \/ \(cacheRead \+ uncached input\); cache-write excluded\)/)
  assert.match(response.text, /Relocation: active/)
  assert.match(response.text, /no header change 1200/)
})

test('warns exactly once when the persona sentence no longer matches', async () => {
  const { ctx, listeners, warnings } = fakeContext()
  apply(ctx, {})
  const assemble = listeners.get('system-prompt/assemble')

  const drifted = source('D:/alpha', 'Work inside {{cwd}}.')
  for (let step = 0; step < 3; step += 1) {
    const result = await assemble(drifted, {}, () => Promise.resolve(drifted))
    assert.deepEqual(result.sections, drifted.sections)
    assert.deepEqual(result.contexts, drifted.contexts)
  }

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /nothing was relocated/)
})

test('survives a context without a logger', async () => {
  const listeners = new Map()
  const ctx = {
    on: (event, handler) => listeners.set(event, handler),
    commands: { register: () => {} },
  }
  apply(ctx, {})
  const drifted = source('D:/alpha', 'Work inside {{cwd}}.')
  const result = await listeners.get('system-prompt/assemble')(drifted, {}, () => Promise.resolve(drifted))
  assert.deepEqual(result.sections, drifted.sections)
})

test('honours the profile patch config', async () => {
  const { ctx, listeners, commands } = fakeContext()
  apply(ctx, { relocateCwd: false, canonicalizeTools: false, cwdContextName: 'cwd' })

  const input = source('D:/alpha')
  const result = await listeners.get('system-prompt/assemble')(input, {}, () => Promise.resolve(input))
  assert.deepEqual(result.sections, input.sections)
  assert.deepEqual(result.contexts, input.contexts)
  assert.equal(result.tools, input.tools)

  const response = commands.get('cache').handler({ agent: { session: { events: [] } } })
  assert.match(response.text, /Relocation: disabled \(relocateCwd: false\)/)
})