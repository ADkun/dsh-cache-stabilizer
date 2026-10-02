# dsh-cache-stabilizer

[![CI](https://github.com/dongsheng123132/dsh-cache-stabilizer/actions/workflows/ci.yml/badge.svg)](https://github.com/dongsheng123132/dsh-cache-stabilizer/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/github/license/dongsheng123132/dsh-cache-stabilizer)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Awesome DSH Plugins](https://img.shields.io/badge/Awesome_DSH-verified_lab-0969da)](https://github.com/dongsheng123132/awesome-dsh-plugins#2origin-plugin-lab)

An MIT-licensed DeepSeek Harness plugin that improves the chance of provider prompt-cache reuse without hiding stale state.

It makes two semantics-preserving changes:

- Moves the working directory out of DSH's known default persona sentence and into the runtime-context snapshot. Different projects can then share the same system-prompt prefix while each request still receives the correct `cwd`.
- Canonicalizes object-key order inside tool schemas. Tool order itself is already deterministic in DSH.

It also adds `/cache`, a human-only command that reports the provider's durable `cacheReadTokens`, uncached `inputTokens`, and cache-write tokens, attributes every miss to a cause, and says whether the relocation is actually happening. It never invents a cache hit.

## What `/cache` reports

```
Cache hit rate: 78.6% (cacheRead / (cacheRead + uncached input); cache-write excluded)
Hit / Miss / Write tokens: 81700 / 22200 / 0
Usage-bearing responses: 6/6
Miss tokens by cause: cold start 14500, no header change 7700
  (no header change = no logged header change: provider TTL expiry or a client-side rewrite)
Recent requests (hit% / miss / cause):
  #5 94.3% miss 1300 no header change
  #6 86.9% miss 2900 no header change
Relocation: active — the cwd sentence left the persona slot on 6/6 assemblies; cwd now arrives in context "dsh-cache-stabilizer:cwd".
```

- The hit rate is `cacheRead / (cacheRead + uncached input)`, with cache-write excluded and the label written out, because DSH reports the three counts as disjoint.
- Causes come from the session's own `request/header` events: `cold start` (first request), `prompt rewritten` (the request surface changed — a compaction fold or a system-prompt update), `tools changed`, `route changed` (provider/model/config), and `header changed` for anything else. `no header change` is the honest unattributed bucket: DSH's header carries the tool catalog and call config but not the system prompt, so a cache expiry inside a stable header cannot be pinned further.
- The recent-request list shows the last 8 requests with per-request hit rate, miss tokens, and cause, so one cold start cannot masquerade as the steady-state rate.
- The relocation line is a direct check that the plugin is doing anything at all (see "When it silently stops working" below).

Command results are never sent to the model — DSH resolves a command without a model turn — so `/cache` cannot change the prompt or cost tokens.

## Where the win actually is

Being honest about the size of the effect matters more than claiming a bigger one:

- In the standard 0.2.x presets the sentence lives in `deployment:persona-suffix`, whose section order is `DEPLOYMENT_PERSONA_SUFFIX` (10200) — the **last** section of the system prompt. There the relocation reclaims roughly one line of tail bytes. Its value is correctness and insurance: the working directory stops being a source of prefix volatility when projects or cwd change.
- The full reclaim appears in deployments that put the sentence in `deployment:persona-prefix` (order 0), or in DSH 0.1.x's single `deployment:persona` section. There the cwd bytes sit in front of everything, and changing project invalidates the whole cached prefix.
- Trailing sections the plugin deliberately does **not** touch: `harness:source` (10000, the harness checkout path) and `app:web-surface` (10100, the local web port). DSH registered those facts itself; rewriting them is out of scope for a stabilizer.

## When it silently stops working

The relocation matches one sentence verbatim. If DSH ever rewords `Your working directory is {{cwd}}.`, relocation would quietly become a no-op — the failure mode that would otherwise look like "the plugin is installed but the cache still misses".

The plugin detects it: it logs one warning per session, and `/cache` prints

```
Relocation: INACTIVE — 3/3 assemblies carried a known persona section without "Your working directory is {{cwd}}." verbatim; DSH may have reworded it.
```

The tracking state is counters and names only; nothing derived from it is ever written into a prompt, so the stabilized bytes do not depend on it.

## Install

```sh
dsh plugin --profile web add dsh-cache-stabilizer
```

Restart DSH, send a few messages, then enter `/cache` in a command-capable client.

If the package is not published on your registry, install this fork from git instead:

```sh
dsh plugin --profile web add github:ADkun/dsh-cache-stabilizer
```

For a custom profile, replace `web` with its profile name. To disable either optimization in a profile patch:

```yaml
- id: dsh-cache-stabilizer
  config:
    relocateCwd: false
    canonicalizeTools: false
    cwdContextName: dsh-cache-stabilizer:cwd
```

`cwdContextName` names the appended runtime-context entry; it is shown verbatim in the client's runtime-context panel. Leave it alone for byte-identical output with earlier releases.

## Safety boundary

Only the exact sentence used by DSH's standard/headless coding persona is relocated. A custom persona that mentions `{{cwd}}` in another form is left unchanged because blindly moving arbitrary prose can change meaning. Both persona layouts are recognized: the single `deployment:persona` section of DSH 0.1.x and the `deployment:persona-prefix` / `deployment:persona-suffix` split introduced in 0.2.x. Only those slots are considered, and only when they contain the sentence verbatim. The plugin does not freeze tool catalogs, reuse stale context, proxy model responses, or implement a second cache.

DeepSeek's provider cache is automatic and depends on an exact prefix match from token zero. Storage and eviction remain provider-controlled.

## Verification

- **Byte-identical default output.** `test/parity.test.mjs` runs the current implementation against the released 0.1.2 module, checked in verbatim as `test/legacy-0.1.2.mjs` (`git show ea27dfd:lib/stabilizer.mjs`), over 12 assembly shapes × 6 configs. It asserts deep equality, serialized equality, identical top-level shape, and that the input assembly is never mutated. The only intended divergence is the opt-in `cwdContextName`.
- **Rendered bytes, not just fields.** `test/render.test.mjs` mirrors DSH's `interpolate` / `joinContextSections` and asserts that two projects render an *identical* system prompt, that the cwd appears exactly once and only in the runtime-context snapshot, and that re-stabilizing is idempotent.
- **Entry point.** `test/plugin.test.mjs` drives `index.js` with a stub context: relocation, tool canonicalization, the one-shot warning, the `/cache` text, a context without a logger, and a profile-patch config.
- **Allocation.** Canonicalization returns an already-canonical schema by reference, so the per-step assembly path allocates nothing for the schemas DSH builds from literals.

## Development

```sh
npm test
npm run check
```