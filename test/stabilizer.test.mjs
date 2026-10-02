import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheReport,
  cacheRequests,
  cacheUsage,
  canonicalize,
  createStabilizerState,
  relocationLine,
  relocationWarning,
  stabilizeAssembly,
} from '../lib/stabilizer.mjs'

function assembly(cwd, persona = 'You are a coding agent. Your working directory is {{cwd}}.', section = 'deployment:persona') {
  return {
    sections: [{ name: section, text: persona }],
    contexts: [],
    tools: [{ name: 'write', parameters: { required: ['path'], properties: { z: { type: 'string' }, a: { type: 'string' } }, type: 'object' } }],
    variables: { cwd, model: 'deepseek' },
  }
}

test('moves the known cwd sentence out of the reusable system prefix', () => {
  const first = stabilizeAssembly(assembly('C:/one'))
  const second = stabilizeAssembly(assembly('D:/two'))
  assert.deepEqual(first.sections, second.sections)
  assert.equal(first.contexts[0].text, 'Working directory: {{cwd}}')
  assert.equal(first.variables.cwd, 'C:/one')
  assert.equal(second.variables.cwd, 'D:/two')
})

test('relocates the cwd sentence from the split 0.2.x persona slots', () => {
  const build = (cwd) => ({
    sections: [
      { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' },
      { name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.' },
    ],
    contexts: [],
    tools: [],
    variables: { cwd, model: 'deepseek' },
  })
  const first = stabilizeAssembly(build('C:/one'))
  const second = stabilizeAssembly(build('D:/two'))
  assert.deepEqual(first.sections, second.sections)
  assert.equal(first.sections[0].text, 'You are a coding agent powered by the {{model}} model.')
  assert.equal(first.sections[1].text, 'Your working directory is provided in the runtime context.')
  assert.equal(first.contexts[0].text, 'Working directory: {{cwd}}')
  assert.equal(first.variables.cwd, 'C:/one')
  assert.equal(second.variables.cwd, 'D:/two')
})

test('relocates from the persona prefix slot when a deployment puts the sentence there', () => {
  const result = stabilizeAssembly(assembly('C:/one', 'Your working directory is {{cwd}}.', 'deployment:persona-prefix'))
  assert.equal(result.sections[0].text, 'Your working directory is provided in the runtime context.')
  assert.equal(result.contexts[0].text, 'Working directory: {{cwd}}')
})

test('leaves the known sentence alone outside a persona slot', () => {
  const original = assembly('C:/one', 'Your working directory is {{cwd}}.', 'agent:custom')
  const result = stabilizeAssembly(original)
  assert.deepEqual(result.sections, original.sections)
  assert.deepEqual(result.contexts, [])
})

test('does not guess how to rewrite a custom persona', () => {
  const original = assembly('C:/one', 'Work carefully in {{cwd}} and never leave it.')
  const result = stabilizeAssembly(original)
  assert.deepEqual(result.sections, original.sections)
  assert.deepEqual(result.contexts, [])
})

test('relocates from a non-interpolating persona section too', () => {
  // The replacement sentence carries no variable and the appended context is
  // interpolated, so the working directory still reaches the model.
  const original = assembly('C:/one')
  original.sections[0].interpolate = false
  const result = stabilizeAssembly(original)
  assert.equal(result.sections[0].text, 'You are a coding agent. Your working directory is provided in the runtime context.')
  assert.equal(result.contexts[0].text, 'Working directory: {{cwd}}')
})

test('canonicalizes schema object keys while preserving array order', () => {
  assert.deepEqual(canonicalize({ z: 1, a: { y: 2, b: 3 }, rows: [{ z: 1, a: 2 }] }), {
    a: { b: 3, y: 2 },
    rows: [{ a: 2, z: 1 }],
    z: 1,
  })
})

test('returns an already-canonical schema by reference', () => {
  // The assembly path runs on every step, so the common case allocates nothing.
  const schema = {
    properties: { content: { type: 'string' }, path: { type: 'string' } },
    required: ['path'],
    type: 'object',
  }
  assert.equal(canonicalize(schema), schema)
  assert.equal(canonicalize(schema.properties), schema.properties)
  const rows = [{ path: 'a' }]
  assert.equal(canonicalize(rows), rows)
  assert.equal(canonicalize('literal'), 'literal')
})

test('rebuilds a schema only where key order changes', () => {
  const unsorted = { z: 1, a: { y: 2, b: 3 } }
  const sorted = canonicalize(unsorted)
  assert.notEqual(sorted, unsorted)
  assert.notEqual(sorted.a, unsorted.a)
  assert.deepEqual(sorted, { a: { b: 3, y: 2 }, z: 1 })
})

test('leaves tools untouched when canonicalization is switched off', () => {
  const source = assembly('C:/one')
  const result = stabilizeAssembly(source, { canonicalizeTools: false })
  assert.equal(result.tools, source.tools)
})

test('reports disjoint provider hit and miss token evidence', () => {
  const events = [
    { type: 'assistant/message', data: { usage: { inputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 20 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 50, cacheReadTokens: 450 } } },
    { type: 'assistant/message', data: {} },
    { type: 'assistant/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 999 } } } },
  ]
  assert.deepEqual(cacheUsage(events), {
    requests: 3,
    reportedRequests: 2,
    hitTokens: 750,
    missTokens: 150,
    writeTokens: 20,
    promptTokens: 900,
    hitRate: 750 / 900,
  })
  assert.match(cacheReport(events).text, /83\.3%/)
})

const TOOL_READ = { name: 'read', parameters: { type: 'object' } }
const TOOL_WRITE = { name: 'write', parameters: { type: 'object' } }

function header(provider, model, tools) {
  return { config: { provider, model }, ...(tools === undefined ? {} : { tools }) }
}

test('attributes each cache miss to a cause logged in the session', () => {
  const events = [
    { type: 'request/header', data: { header: header('p', 'm', [TOOL_READ]), reason: 'initial' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 14000, cacheReadTokens: 0 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 1200, cacheReadTokens: 13000 } } },
    { type: 'request/header', data: { header: header('p', 'm', [TOOL_READ, TOOL_WRITE]), reason: 'change' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 900, cacheReadTokens: 14000 } } },
    { type: 'request/header', data: { header: header('p', 'm', [TOOL_READ, TOOL_WRITE]), reason: 'series' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 5000, cacheReadTokens: 11000 } } },
    { type: 'request/header', data: { header: header('other', 'm', [TOOL_READ, TOOL_WRITE]), reason: 'change' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 700, cacheReadTokens: 15000 } } },
  ]

  assert.deepEqual(cacheRequests(events).map((record) => record.cause), ['cold', 'none', 'tools', 'prompt', 'route'])
  assert.deepEqual(cacheRequests(events).map((record) => record.index), [1, 2, 3, 4, 5])

  const report = cacheReport(events).text
  assert.match(report, /cache-write excluded/)
  assert.match(report, /Miss tokens by cause: cold start 14000, prompt rewritten 5000, no header change 1200, tools changed 900, route changed 700/)
  assert.match(report, /no header change = no logged header change/)
  assert.match(report, /#1 0\.0% miss 14000 cold start/)
  assert.match(report, /#3 94\.0% miss 900 tools changed/)
  assert.match(report, /#5 95\.5% miss 700 route changed/)
})

test('bounds the per-request section and says what it dropped', () => {
  const events = []
  for (let index = 0; index < 12; index += 1) {
    events.push({ type: 'assistant/message', data: { usage: { inputTokens: 10, cacheReadTokens: 90 } } })
  }
  const report = cacheReport(events).text
  assert.match(report, /Recent requests \(hit% \/ miss \/ cause\), last 8 of 12:/)
  assert.match(report, /#5 /)
  assert.doesNotMatch(report, /#4 /)
})

test('records relocation state without changing the assembly', () => {
  const state = createStabilizerState()
  const source = assembly('C:/one')
  const result = stabilizeAssembly(source, {}, state)
  assert.deepEqual(result.sections, stabilizeAssembly(source).sections)
  assert.deepEqual(result.contexts, stabilizeAssembly(source).contexts)
  assert.deepEqual(state, {
    assemblies: 1,
    relocationEnabled: true,
    personaAssemblies: 1,
    relocatedAssemblies: 1,
    unmatchedAssemblies: 0,
    contextName: 'dsh-cache-stabilizer:cwd',
  })
  assert.match(relocationLine(state), /^Relocation: active/)
  assert.equal(relocationWarning(state), undefined)
})

test('flags a persona section that no longer matches the sentence verbatim', () => {
  const state = createStabilizerState()
  stabilizeAssembly(assembly('C:/one', 'Work inside {{cwd}}.', 'deployment:persona-suffix'), {}, state)
  assert.equal(state.relocatedAssemblies, 0)
  assert.equal(state.unmatchedAssemblies, 1)
  assert.match(relocationLine(state), /Relocation: INACTIVE/)
  assert.match(relocationWarning(state), /does not contain "Your working directory is \{\{cwd\}\}\." verbatim/)
})

test('does not warn when relocation is switched off', () => {
  const state = createStabilizerState()
  const source = assembly('C:/one')
  const result = stabilizeAssembly(source, { relocateCwd: false }, state)
  assert.deepEqual(result.sections, source.sections)
  assert.equal(result.contexts, source.contexts)
  assert.equal(state.personaAssemblies, 1)
  assert.equal(state.unmatchedAssemblies, 0)
  assert.equal(state.relocatedAssemblies, 0)
  assert.equal(relocationWarning(state), undefined)
})

test('honours a custom cwd context name', () => {
  const state = createStabilizerState()
  const result = stabilizeAssembly(assembly('C:/one'), { cwdContextName: 'cwd' }, state)
  assert.deepEqual(result.contexts, [{ name: 'cwd', text: 'Working directory: {{cwd}}' }])
  assert.match(relocationLine(state), /in context "cwd"/)
})

test('reports relocation even before any usage arrives', () => {
  const state = createStabilizerState()
  stabilizeAssembly(assembly('C:/one'), {}, state)
  const text = cacheReport([], { state }).text
  assert.match(text, /no provider cache metrics yet/)
  assert.match(text, /Relocation: active/)
})