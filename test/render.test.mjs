import test from 'node:test'
import assert from 'node:assert/strict'
import { stabilizeAssembly } from '../lib/stabilizer.mjs'

/**
 * Minimal mirror of the renderer the assertions below hold the plugin to.
 *
 * `interpolate` and `joinContextSections` in
 * `@deepseek-ai/dsh-system-prompt/lib/index.js` substitute `{{name}}` from the
 * assembly variables (throwing on an unknown or valueless name), join section
 * texts in order, and prefix a non-empty context snapshot with
 * "Current runtime context. This snapshot supersedes earlier runtime-context
 * snapshots.". `interpolate: false` sections keep their literal text.
 */
function interpolate(text, variables, kind) {
  return text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (match, name) => {
    if (!Object.hasOwn(variables, name) || variables[name] === undefined) {
      throw new Error(`prompt variable ${match} has no value for this ${kind}`)
    }
    return String(variables[name])
  })
}

function renderSystemPrompt(assembly) {
  return assembly.sections
    .map((section) => (section.interpolate === false
      ? section.text
      : interpolate(section.text, assembly.variables, 'section')))
    .join('\n\n')
}

function renderRuntimeContext(assembly) {
  const body = assembly.contexts
    .map((context) => interpolate(context.text, assembly.variables, 'context'))
    .join('\n\n')
  return body === '' ? '' : `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`
}

/** A realistic 0.2.x assembly: persona slots, guidance, environment facts, tools. */
function build(cwd) {
  return {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by the {{model}} model.' },
      { name: 'guidance:tool-discipline', text: 'Use the read tool before editing a file.' },
      { name: 'harness:tools-sdk', text: 'Call tools through the documented SDK shapes.' },
      { name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.' },
    ],
    contexts: [
      { name: 'sandbox-policy', text: 'Current DSH file policy: danger-full-access.' },
      { name: 'approval-policy', text: 'Approval prompts are disabled in this session.' },
    ],
    tools: [
      { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    ],
    variables: { cwd, model: 'deepseek-v4.1-flash' },
  }
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

test('two projects render an identical, cwd-independent system-prompt prefix', () => {
  const alpha = stabilizeAssembly(build('D:/alpha'))
  const beta = stabilizeAssembly(build('D:/beta'))

  const alphaPrompt = renderSystemPrompt(alpha)
  const betaPrompt = renderSystemPrompt(beta)
  assert.equal(alphaPrompt, betaPrompt)
  assert.equal(occurrences(alphaPrompt, 'D:/alpha'), 0)
  assert.equal(occurrences(alphaPrompt, 'D:/beta'), 0)
})

test('the cached prefix bytes include the whole guidance block and the tool schemas', () => {
  // Providers match a prefix from token zero and DSH sends tool schemas before
  // the system prompt, so both must be project-independent for reuse to work.
  const alpha = stabilizeAssembly(build('D:/alpha'))
  const beta = stabilizeAssembly(build('D:/beta'))
  assert.equal(JSON.stringify(alpha.tools), JSON.stringify(beta.tools))
  assert.deepEqual(alpha.variables, { cwd: 'D:/alpha', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(beta.variables, { cwd: 'D:/beta', model: 'deepseek-v4.1-flash' })
})

test('each project still receives exactly one cwd, in the runtime-context snapshot', () => {
  const alpha = stabilizeAssembly(build('D:/alpha'))
  const beta = stabilizeAssembly(build('D:/beta'))

  const alphaContext = renderRuntimeContext(alpha)
  assert.equal(occurrences(alphaContext, 'D:/alpha'), 1)
  assert.match(alphaContext, /Current runtime context\. This snapshot supersedes earlier runtime-context snapshots\./)
  assert.match(alphaContext, /Working directory: D:\/alpha/)

  const betaContext = renderRuntimeContext(beta)
  assert.equal(occurrences(betaContext, 'D:/beta'), 1)
  assert.equal(occurrences(betaContext, 'D:/alpha'), 0)
})

test('without relocation the project path stays inside the cached system prefix', () => {
  // Contrast case that documents what the plugin is for.
  const alpha = stabilizeAssembly(build('D:/alpha'), { relocateCwd: false })
  const beta = stabilizeAssembly(build('D:/beta'), { relocateCwd: false })
  assert.notEqual(renderSystemPrompt(alpha), renderSystemPrompt(beta))
  assert.equal(occurrences(renderSystemPrompt(alpha), 'D:/alpha'), 1)
})

test('re-stabilizing an assembly is idempotent', () => {
  const once = stabilizeAssembly(build('D:/alpha'))
  const twice = stabilizeAssembly(once)
  assert.deepEqual(twice.sections, once.sections)
  assert.deepEqual(twice.contexts, once.contexts)
  assert.equal(renderSystemPrompt(twice), renderSystemPrompt(once))
})

test('freezes the default output contract that the 0.1.2 prompt bytes relied on', () => {
  const source = build('D:/alpha')
  const result = stabilizeAssembly(source)

  // No new top-level or section fields: the assembled shape is unchanged.
  assert.deepEqual(Object.keys(result), Object.keys(source))
  assert.deepEqual(Object.keys(result.sections[4]), Object.keys(source.sections[4]))

  // Exactly the known sentence is rewritten, and the replacement is verbatim.
  assert.equal(result.sections[4].text, 'Your working directory is provided in the runtime context.')
  assert.equal(source.sections[4].text, 'Your working directory is {{cwd}}.')
  assert.equal(result.sections[1].text, source.sections[1].text)

  // Exactly one context is appended, with the historical name and text.
  assert.equal(result.contexts.length, source.contexts.length + 1)
  assert.deepEqual(result.contexts.at(-1), { name: 'dsh-cache-stabilizer:cwd', text: 'Working directory: {{cwd}}' })
})