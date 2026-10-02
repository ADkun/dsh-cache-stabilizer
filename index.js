import {
  cacheReport,
  createStabilizerState,
  relocationWarning,
  stabilizeAssembly,
} from './lib/stabilizer.mjs'

export const name = 'dsh-cache-stabilizer'
export const inject = ['commands']

export function apply(ctx, config = {}) {
  const state = createStabilizerState()
  let warned = false

  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    const stabilized = stabilizeAssembly(assembled, config, state)
    if (!warned) {
      const warning = relocationWarning(state)
      if (warning !== undefined) {
        warned = true
        ctx.logger?.warn?.(warning)
      }
    }
    return stabilized
  })

  ctx.commands.register({
    name: 'cache',
    description: 'Show provider-reported cache hits, per-request miss attribution, and relocation state',
    handler: ({ agent }) => ({
      kind: 'success',
      text: cacheReport(agent.session.events, { state }).text,
    }),
  })
}