/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-handoff`.
 * @module @deepseek-ai/dsh-handoff/invariant
 */

/* jscpd:ignore-start */
import fs from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { HandoffSettledPayload } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-handoff'

/** Cordis companion plugin name. */
export const name = 'handoff-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The durable per-session handoff file path. */
function handoffPath(sessionId: string): string {
  const safe = sessionId.replace(/[\\/]/g, '_').replace(/\.\./g, '_')
  return path.join(dshHomePath('.handoff'), `${safe}.json`)
}

/** Read one handoff record, or undefined when absent / malformed. */
function readHandoff(sessionId: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(handoffPath(sessionId), 'utf8')
    const record: unknown = JSON.parse(raw)
    return record !== null && typeof record === 'object' ? record as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * A `handoff/settled` event with outcome `written` must be backed by a durable
 * pending record for the same agent: the tool writes the file before emitting
 * the event, so a written settlement without a file means an event was emitted
 * without its durable commit (or the file was consumed out from under it). A
 * `cleared` settlement legitimately has no file, so it is excluded.
 */
const install: InvariantInstaller = (ctx, fail) => {
  ctx.on('handoff/settled', (payload: HandoffSettledPayload) => {
    if (payload.outcome !== 'written') return
    const record = readHandoff(payload.agentId)
    if (record === undefined) {
      fail(`handoff/settled written for ${payload.agentId} without a durable pending record`)
    } else if (record.pending !== true) {
      fail(`handoff/settled written for ${payload.agentId} with pending=${String(record.pending)}`)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
