import test from 'node:test'
import assert from 'node:assert/strict'
import { stabilizeAssembly } from '../lib/stabilizer.mjs'
import { stabilizeAssembly as legacyStabilize } from './legacy-0.1.2.mjs'

/**
 * Differential test against the released 0.1.2 implementation.
 *
 * The 0.1.2 module is checked in verbatim (see `git show ea27dfd:lib/stabilizer.mjs`,
 * so the current, allocation-optimized code can be proved to produce the same
 * prompt bytes as the version users already have cached. The renderer DSH uses
 * is a pure function of `sections` / `contexts` / `variables`, so structural
 * equality here is byte equality after `{{...}}` interpolation.
 *
 * `cwdContextName` is deliberately excluded: it is the one new opt-in knob, and
 * `honours cwdContextName as a deliberate divergence` below pins it down.
 */

function assembly(overrides = {}) {
  return {
    sections: overrides.sections ?? [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' },
      { name: 'harness:tools-sdk', text: 'Call tools through the documented SDK shapes.' },
      { name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.' },
    ],
    contexts: overrides.contexts ?? [
      { name: 'sandbox-policy', text: 'Current DSH file policy: danger-full-access.' },
      { name: 'approval-policy', text: 'Approval prompts are disabled in this session.' },
    ],
    tools: overrides.tools ?? [
      {
        name: 'write',
        parameters: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            z: { type: 'string' },
            a: { type: 'array', items: { type: 'string' } },
            nested: { type: 'object', properties: { b: { type: 'number' }, a: { type: 'number' } } },
          },
        },
      },
      { name: 'read', parameters: { properties: { path: { type: 'string' } }, type: 'object' } },
    ],
    variables: overrides.variables ?? { cwd: 'D:/alpha', model: 'deepseek-v4.1-flash' },
  }
}

function withSuffix(text, name = 'deployment:persona-suffix', extra = {}) {
  return assembly({
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name, text, ...extra },
    ],
  })
}

const CASES = [
  ['the 0.2.x suffix slot', () => assembly()],
  ['the 0.2.x prefix slot', () => withSuffix('Your working directory is {{cwd}}.', 'deployment:persona-prefix')],
  ['the single 0.1.x persona slot', () => withSuffix('Your working directory is {{cwd}}.', 'deployment:persona')],
  ['a non-persona slot carrying the sentence', () => withSuffix('Your working directory is {{cwd}}.', 'guidance:note')],
  ['a custom persona with different prose', () => withSuffix('Work inside {{cwd}} on the user\'s project.')],
  ['a non-interpolating persona section', () => withSuffix('Your working directory is {{cwd}}.', 'deployment:persona-suffix', { interpolate: false })],
  ['the sentence appearing twice', () => withSuffix('Your working directory is {{cwd}}. Your working directory is {{cwd}}.')],
  ['extra prose around the sentence', () => withSuffix('Be concise. Your working directory is {{cwd}}. Prefer rg.')],
  ['an empty assembly', () => assembly({ sections: [], contexts: [], tools: [], variables: {} })],
  ['a cwd context that is already present', () => assembly({
    contexts: [
      { name: 'sandbox-policy', text: 'Current DSH file policy: danger-full-access.' },
      { name: 'dsh-cache-stabilizer:cwd', text: 'Working directory: {{cwd}}' },
    ],
  })],
  ['already-canonical tool schemas', () => assembly({
    tools: [{ name: 'read', parameters: { properties: { path: { type: 'string' } }, type: 'object' } }],
  })],
  ['exotic tool schemas', () => assembly({
    tools: [
      { name: 'weird', parameters: undefined },
      { name: 'null-parameters', parameters: null },
      { name: 'null-prototype', parameters: Object.assign(Object.create(null), { b: 1, a: 2 }) },
      { name: 'no-parameters' },
    ],
  })],
]

const CONFIGS = [
  ['defaults', undefined],
  ['relocateCwd: false', { relocateCwd: false }],
  ['canonicalizeTools: false', { canonicalizeTools: false }],
  ['both switches off', { relocateCwd: false, canonicalizeTools: false }],
  ['an unknown key', { future: true }],
  ['relocateCwd: 0', { relocateCwd: 0 }],
]

test('the default output is byte-identical to the released 0.1.2 implementation', () => {
  for (const [caseName, build] of CASES) {
    for (const [configName, config] of CONFIGS) {
      const label = `${caseName} with ${configName}`
      const source = build()
      const before = JSON.stringify(source)

      const legacy = config === undefined ? legacyStabilize(build()) : legacyStabilize(build(), config)
      const current = config === undefined ? stabilizeAssembly(build()) : stabilizeAssembly(build(), config)

      assert.deepEqual(current, legacy, `${label}: result differs from 0.1.2`)
      assert.equal(JSON.stringify(current), JSON.stringify(legacy), `${label}: serialized bytes differ`)
      assert.deepEqual(Object.keys(current), Object.keys(legacy), `${label}: top-level shape differs`)
      assert.equal(JSON.stringify(source), before, `${label}: the input assembly was mutated`)
    }
  }
})

test('the diagnostics out-parameter does not change the result', () => {
  const source = assembly()
  const state = {}
  const withState = stabilizeAssembly(source, {}, state)
  const withoutState = stabilizeAssembly(assembly(), {})
  assert.deepEqual(withState, withoutState)
})

test('cwdContextName is a deliberate, opt-in divergence', () => {
  const source = assembly()
  const legacy = legacyStabilize(source)
  const current = stabilizeAssembly(assembly(), { cwdContextName: 'cwd' })

  assert.deepEqual(current.sections, legacy.sections)
  assert.deepEqual(current.tools, legacy.tools)
  assert.equal(current.contexts.length, legacy.contexts.length)
  assert.deepEqual(current.contexts.at(-1), { name: 'cwd', text: 'Working directory: {{cwd}}' })
  assert.deepEqual(legacy.contexts.at(-1), { name: 'dsh-cache-stabilizer:cwd', text: 'Working directory: {{cwd}}' })
})