const DEFAULT_CWD_SENTENCE = 'Your working directory is {{cwd}}.'
const STABLE_CWD_SENTENCE = 'Your working directory is provided in the runtime context.'
/**
 * Section names a standard deployment persona occupies. DSH 0.1.x kept the
 * persona in one `deployment:persona` section; 0.2.x splits it into
 * `deployment:persona-prefix` and `deployment:persona-suffix`
 * (`PERSONA_PREFIX_SECTION` / `PERSONA_SUFFIX_SECTION` in
 * `@deepseek-ai/dsh-system-prompt`), and `@deepseek-ai/dsh-persona` puts its
 * configured `suffix` — the sentence relocated below — in the suffix slot.
 * Only these known slots are considered; a custom persona elsewhere in the
 * assembly stays untouched.
 */
const PERSONA_SECTIONS = new Set([
  'deployment:persona',
  'deployment:persona-prefix',
  'deployment:persona-suffix',
])
const CWD_CONTEXT = 'dsh-cache-stabilizer:cwd'
const CWD_CONTEXT_TEXT = 'Working directory: {{cwd}}'
const REPORTED_LIMIT = 8

/**
 * Diagnostics the assembly path records for `/cache` and for the one-shot
 * compatibility warning. Every field is a counter or a name: nothing here, and
 * nothing derived from it, is ever written into a prompt, so the stabilized
 * prompt bytes do not depend on this state.
 * @returns a fresh state object for one plugin instance.
 */
export function createStabilizerState() {
  return {
    assemblies: 0,
    relocationEnabled: undefined,
    personaAssemblies: 0,
    relocatedAssemblies: 0,
    unmatchedAssemblies: 0,
    contextName: undefined,
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Return an equivalent JSON-like value with object keys in code-unit order.
 * A value that is already canonical is returned by reference, so the per-step
 * assembly path allocates nothing for the schemas DSH builds from literals;
 * the returned graph is deep-equal to the always-rebuild version.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) {
    let changed = false
    const mapped = value.map((item) => {
      const next = canonicalize(item)
      if (next !== item) changed = true
      return next
    })
    return changed ? mapped : value
  }
  if (!isPlainObject(value)) return value
  const keys = Object.keys(value)
  const sorted = [...keys].sort()
  let ordered = true
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== sorted[index]) {
      ordered = false
      break
    }
  }
  let changed = false
  const entries = sorted.map((key) => {
    const next = canonicalize(value[key])
    if (next !== value[key]) changed = true
    return [key, next]
  })
  if (ordered && !changed) return value
  return Object.fromEntries(entries)
}

function resolveContextName(config) {
  const name = config.cwdContextName
  return typeof name === 'string' && name.length > 0 ? name : CWD_CONTEXT
}

/**
 * Stabilize only semantics-preserving parts of a DSH prompt assembly.
 * Unknown/custom personas are deliberately left untouched.
 *
 * The default output is byte-identical to 0.1.2; `state` is an out-parameter
 * that only records what happened.
 *
 * @param assembly - the assembled prompt.
 * @param config - plugin config (`relocateCwd`, `canonicalizeTools`,
 *   `cwdContextName`).
 * @param state - optional {@link createStabilizerState} object to update.
 */
export function stabilizeAssembly(assembly, config = {}, state = undefined) {
  const relocateCwd = config.relocateCwd !== false
  const canonicalizeTools = config.canonicalizeTools !== false
  const cwdContextName = resolveContextName(config)
  let personaSlot = false
  let matchedSentence = false
  let relocated = false

  const sections = assembly.sections.map((section) => {
    if (!PERSONA_SECTIONS.has(section.name)) return section
    personaSlot = true
    if (!section.text.includes(DEFAULT_CWD_SENTENCE)) return section
    matchedSentence = true
    if (!relocateCwd) return section
    relocated = true
    return {
      ...section,
      text: section.text.replace(DEFAULT_CWD_SENTENCE, STABLE_CWD_SENTENCE),
    }
  })

  const contexts = relocated && !assembly.contexts.some((entry) => entry.name === cwdContextName)
    ? [...assembly.contexts, { name: cwdContextName, text: CWD_CONTEXT_TEXT }]
    : assembly.contexts

  if (state !== null && typeof state === 'object') {
    state.assemblies += 1
    state.relocationEnabled = relocateCwd
    if (personaSlot) state.personaAssemblies += 1
    if (personaSlot && !matchedSentence) state.unmatchedAssemblies += 1
    if (relocated) {
      state.relocatedAssemblies += 1
      state.contextName = cwdContextName
    }
  }

  return {
    ...assembly,
    sections,
    contexts,
    tools: canonicalizeTools ? assembly.tools.map(canonicalize) : assembly.tools,
  }
}

/** Fold finalized assistant usage records without double-counting stream chunks. */
export function cacheUsage(events) {
  let requests = 0
  let hitTokens = 0
  let missTokens = 0
  let writeTokens = 0
  let reportedRequests = 0

  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    requests += 1
    const usage = event.data?.usage
    if (usage === undefined) continue
    reportedRequests += 1
    hitTokens += Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : 0
    missTokens += Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
    writeTokens += Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : 0
  }

  const promptTokens = hitTokens + missTokens
  return {
    requests,
    reportedRequests,
    hitTokens,
    missTokens,
    writeTokens,
    promptTokens,
    hitRate: promptTokens === 0 ? undefined : hitTokens / promptTokens,
  }
}

/**
 * Human-readable cause of a cache miss, attributed from the session log rather
 * than guessed. `prompt` outranks the others because a rewritten surface (a
 * compression fold, a system-prompt edit) discards every cached token after the
 * edit point.
 */
const CAUSE_LABELS = {
  cold: 'cold start',
  prompt: 'prompt rewritten',
  tools: 'tools changed',
  route: 'route changed',
  other: 'header changed',
  none: 'no header change',
}

const CAUSE_NOTES = {
  none: 'no header change = no logged header change: provider TTL expiry or a client-side rewrite',
  prompt: 'prompt rewritten = the request surface changed (compaction fold or system-prompt update)',
  route: 'route changed = provider/model/config changed',
}

function headerTools(header) {
  return Array.isArray(header?.tools) ? header.tools : []
}

/** Mirrors `sameSchema` in `@deepseek-ai/dsh-session`'s `headerEquals`. */
function sameTools(before, after) {
  const previous = headerTools(before)
  const current = headerTools(after)
  return previous.length === current.length
    && previous.every((tool, index) => JSON.stringify(tool) === JSON.stringify(current[index]))
}

/**
 * Mirrors the `callConfigEquals` + adapter-defaults comparison of
 * `headerEquals`. Config is compared as canonical JSON, which is the same
 * granularity DSH itself uses to decide whether to log a new header.
 */
function sameRoute(before, after) {
  return JSON.stringify(before?.config) === JSON.stringify(after?.config)
    && before?.adapterDefaults?.reasoningEffort === after?.adapterDefaults?.reasoningEffort
    && before?.adapterDefaults?.maxTokens === after?.adapterDefaults?.maxTokens
}

function causeFor(previous, next, data) {
  if (previous === undefined) return 'cold'
  if (data?.startsSeries === true || data?.reason === 'series') return 'prompt'
  if (!sameTools(previous, next)) return 'tools'
  if (!sameRoute(previous, next)) return 'route'
  return 'other'
}

/**
 * Attribute each finalized request's cache miss to a logged cause.
 * Requests are counted from `request/header` events, so a request that logged
 * no header change is reported as `none` — the honest unattributed bucket.
 *
 * @param events - session events in log order.
 * @returns one record per `assistant/message`, in request order.
 */
export function cacheRequests(events) {
  const records = []
  let header
  let cause = 'cold'

  for (const event of events) {
    if (event?.type === 'request/header') {
      cause = causeFor(header, event.data?.header, event.data)
      header = event.data?.header
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    records.push({
      index: records.length + 1,
      cause,
      reported: usage !== undefined,
      hitTokens: Number.isFinite(usage?.cacheReadTokens) ? usage.cacheReadTokens : 0,
      missTokens: Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0,
      writeTokens: Number.isFinite(usage?.cacheWriteTokens) ? usage.cacheWriteTokens : 0,
    })
    cause = 'none'
  }

  return records
}

function hitPercent(record) {
  const promptTokens = record.hitTokens + record.missTokens
  return promptTokens === 0 ? 'n/a' : `${((record.hitTokens / promptTokens) * 100).toFixed(1)}%`
}

/**
 * Report what the plugin did, and what the provider actually charged for.
 * Human-only: DSH command results are never sent to the model.
 *
 * @param events - session events.
 * @param options - `{ state, limit }`; `state` adds the relocation line.
 */
export function cacheReport(events, options = {}) {
  const usage = cacheUsage(events)
  const requests = cacheRequests(events)
  const lines = []

  if (usage.reportedRequests === 0) {
    lines.push(
      'Cache: no provider cache metrics yet. Send at least one message; the selected provider must report cacheReadTokens/inputTokens.',
    )
  } else {
    const percent = usage.hitRate === undefined ? 'n/a' : `${(usage.hitRate * 100).toFixed(1)}%`
    lines.push(`Cache hit rate: ${percent} (cacheRead / (cacheRead + uncached input); cache-write excluded)`)
    lines.push(`Hit / Miss / Write tokens: ${usage.hitTokens} / ${usage.missTokens} / ${usage.writeTokens}`)
    lines.push(`Usage-bearing responses: ${usage.reportedRequests}/${usage.requests}`)

    const byCause = new Map()
    for (const record of requests) {
      if (record.missTokens > 0) byCause.set(record.cause, (byCause.get(record.cause) ?? 0) + record.missTokens)
    }
    if (byCause.size > 0) {
      const parts = [...byCause.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([cause, tokens]) => `${CAUSE_LABELS[cause]} ${tokens}`)
      lines.push(`Miss tokens by cause: ${parts.join(', ')}`)
      const notes = [...byCause.keys()].map((cause) => CAUSE_NOTES[cause]).filter(Boolean)
      if (notes.length > 0) lines.push(`  (${notes.join('; ')})`)
    }

    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : REPORTED_LIMIT
    const recent = requests.slice(-limit)
    if (recent.length > 0) {
      const omitted = requests.length - recent.length
      lines.push(`Recent requests (hit% / miss / cause)${omitted > 0 ? `, last ${recent.length} of ${requests.length}` : ''}:`)
      for (const record of recent) {
        lines.push(`  #${record.index} ${hitPercent(record)} miss ${record.missTokens} ${CAUSE_LABELS[record.cause]}`)
      }
    }
  }

  const relocation = relocationLine(options.state)
  if (relocation !== undefined) lines.push(relocation)

  return { usage, requests, text: lines.join('\n') }
}

/**
 * One line describing whether the relocation is actually happening.
 * Deliberately surfaces the silent-failure case: DSH rewords the sentence and
 * the plugin stops working without any other symptom.
 */
export function relocationLine(state) {
  if (state === null || typeof state !== 'object') return undefined
  const context = typeof state.contextName === 'string' ? state.contextName : CWD_CONTEXT
  if (!Number.isFinite(state.assemblies) || state.assemblies === 0) {
    return 'Relocation: not observed yet (no prompt assembled in this session).'
  }
  if (state.relocationEnabled === false) {
    return 'Relocation: disabled (relocateCwd: false) — the cwd sentence stays inside the system prompt.'
  }
  if (state.relocatedAssemblies > 0 && state.unmatchedAssemblies === 0) {
    return `Relocation: active — the cwd sentence left the persona slot on ${state.relocatedAssemblies}/${state.assemblies} assemblies; cwd now arrives in context "${context}".`
  }
  if (state.unmatchedAssemblies > 0 && state.relocatedAssemblies === 0) {
    return `Relocation: INACTIVE — ${state.unmatchedAssemblies}/${state.assemblies} assemblies carried a known persona section without ${JSON.stringify(DEFAULT_CWD_SENTENCE)} verbatim; DSH may have reworded it.`
  }
  if (state.unmatchedAssemblies > 0) {
    return `Relocation: partial — active on ${state.relocatedAssemblies} assemblies, unmatched on ${state.unmatchedAssemblies} of ${state.assemblies}.`
  }
  return 'Relocation: no persona section seen; this deployment may use a custom persona.'
}

/**
 * The one-shot compatibility warning, or `undefined` when nothing is wrong.
 * Log-only text: it never enters a prompt.
 */
export function relocationWarning(state) {
  if (state === null || typeof state !== 'object') return undefined
  if (!Number.isFinite(state.unmatchedAssemblies) || state.unmatchedAssemblies === 0) return undefined
  return `dsh-cache-stabilizer: a known persona section is present but does not contain ${JSON.stringify(DEFAULT_CWD_SENTENCE)} verbatim, so nothing was relocated; DSH may have reworded the sentence. Run /cache for the full picture.`
}