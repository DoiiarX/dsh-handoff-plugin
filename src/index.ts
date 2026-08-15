/**
 * Restart handoff (遗言) — durable per-session "last will" notes, plus an
 * automatic continue-reminder when a Host restart resumes a session.
 *
 * Closing the loop that a dynamic, process-local plugin cannot:
 *   * tools `handoff_save` / `handoff_clear` write/clear a durable JSON file
 *     for the calling agent, keyed by its `agent.id` (= SessionId), under
 *     `<DSH_HOME>/.handoff/<sessionId>.json`.
 *   * on `agent/session-start` with source `resume` (a Host restart reloaded
 *     this session from its durable log), if a pending handoff exists for that
 *     agent it is delivered ONCE via `agent.followup()` as model-facing context,
 *     then the pending flag is cleared so a later unrelated restart does not
 *     re-remind the same task.
 *
 * Only agents that would be interrupted by the restart leave a will; normal /
 * finished conversations never have a file, so they are never disturbed after
 * a restart. Each agent only ever touches its own per-session file ("只能给
 * 自己留遗言，重启后提醒自己继续").
 *
 * The restart broadcast (`handoff_at_restart`) is EVENT-DRIVEN, never polled:
 * it cancels each target, awaits the agent's quiescence (`whenIdle()`), sends
 * one independent handoff turn, and then listens for the `handoff/settled`
 * event that `handoff_save` / `handoff_clear` emit. Only records settled FOR
 * the current broadcast (matching its `requestId`) count as confirmation — a
 * stale record left by an earlier restart can never be misread as "done".
 * The supervisor restart file is written ONLY when every target has settled;
 * on timeout the tool reports the unconfirmed agents and does NOT restart, so
 * a restart never cuts a working agent without a chance to leave its will.
 *
 * @module @deepseek-ai/dsh-handoff
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { boundContextSummary, createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

export const name = 'tool-handoff'
export const inject = ['tools', 'agents', 'agentPresets', 'timer']

const SOURCE_PLUGIN = 'handoff'

/**
 * One agent settled its handoff for a broadcast: it either wrote a will
 * (`written`) or deliberately cleared one (`cleared`, meaning "nothing in
 * progress — no will needed"). The event carries the broadcast `requestId` so
 * the in-flight broadcast can confirm exactly the results it requested.
 */
export interface HandoffSettledPayload {
  /** The agent that settled its handoff. */
  agentId: string
  /** The broadcast requestId this settlement belongs to, when it was requested. */
  requestId?: string
  /** Whether a will was written or deliberately cleared. */
  outcome: 'written' | 'cleared'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Emitted when one agent settles its handoff for a broadcast, either by
     * writing a will (`written`) or deliberately clearing it (`cleared`,
     * meaning nothing is in progress). The payload carries the broadcast
     * `requestId` so the in-flight broadcast can confirm exactly the
     * results it requested.
     *
     * @param payload.agentId - the agent that settled its handoff.
     * @param payload.requestId - the broadcast requestId this settlement belongs to, when it was requested.
     * @param payload.outcome - whether a will was written or deliberately cleared.
     * @mode emit
     */
    'handoff/settled'(payload: HandoffSettledPayload): void
  }
}

/**
 * The one restart broadcast currently in flight, or null. Set when a
 * `handoff_at_restart` call opens a window (agents cancelled, independent
 * handoff turns sent) and cleared when the window closes (every target
 * settled or the wait budget elapsed).
 *
 * This carries the broadcast's own identity so that:
 *   * the idle→deliver listener knows a restart is imminent and MUST NOT
 *     consume other agents' freshly written handoffs (followup + pending:false)
 *     — the restart has not happened yet, and auto-recover must still find
 *     them pending after the Host comes back;
 *   * settlement confirmation accepts only events raised FOR this broadcast
 *     (`requestId` match), never a stale record left by an earlier restart.
 *
 * Without the identity, an agent that writes its will on request goes idle a
 * moment later, the idle listener delivers + clears its pending flag, and the
 * restart's auto-recover skips it ("no pending record") — exactly the "wrote a
 * will, it was consumed immediately, then restart" failure observed in the
 * wild. And a pre-existing record could be accepted as "done" even when the
 * agent never wrote a will for this broadcast (the stale-record misjudgment).
 */
let activeBroadcast: {
  /** Unique identity of this broadcast, stamped into wills written for it. */
  requestId: string
  /** Epoch (ms) when the broadcast opened; only later writes can satisfy it. */
  requestedAt: number
  /** The agent that initiated this restart, surfaced to targets in their reminder. */
  initiatorId?: string | undefined
  /** Target agent ids this broadcast waits on. */
  targets: Set<string>
} | null = null

/**
 * Host process start time (ms). The idle→deliver listener must only deliver
 * handoffs written BEFORE this host started — i.e. leftovers from a previous
 * Host life that auto-recover is expected to surface. A handoff written DURING
 * this host's life (by handoff_save, whether requested by broadcast or by a
 * direct message) must stay pending untouched: it is destined for the NEXT
 * restart's auto-recover. Consuming it here (followup + pending:false) is the
 * exact "wrote a will → it was consumed immediately → restart → no pending
 * record → session not recovered" failure observed repeatedly.
 */
const HOST_START_EPOCH = Date.now()

/** The durable per-session handoff directory. */
function handoffDir(): string {
  return dshHomePath('.handoff')
}

/** The per-session handoff file path (safe single component). */
function handoffPath(sessionId: string): string {
  const safe = sessionId.replace(/[\\/]/g, '_').replace(/\.\./g, '_')
  return path.join(handoffDir(), `${safe}.json`)
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

/** Atomically write (temp + rename) one handoff record. */
function writeHandoff(sessionId: string, record: Record<string, unknown>): void {
  const file = handoffPath(sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Deliver one pending handoff to its owner session via `agent.followup()` and
 * clear the pending flag so it is only ever surfaced once.
 * @returns whether a reminder was actually delivered.
 */
function deliverPendingHandoff(agent: Agent): boolean {
  const record = readHandoff(agent.id)
  if (record === undefined) return false
  if (record.pending === false) return false
  const objective = typeof record.objective === 'string' && record.objective ? record.objective : 'an unfinished task'
  const note = typeof record.note === 'string' && record.note ? record.note : ''
  const initiatorId = typeof record.initiatorId === 'string' ? record.initiatorId : undefined

  // Say WHO restarted the Host so a recovered session is never confused about
  // why it was cut: a deliberate broadcast names its initiator, while an
  // unattested restart (agent behind the broadcast's back, user button,
  // supervisor SIGTERM) is called out as unexpected.
  const restartOrigin = initiatorId !== undefined
    ? `This restart was initiated by session "${initiatorId}" via the handoff broadcast.`
    : 'This restart was UNEXPECTED: it did NOT go through the `handoff_at_restart` broadcast (an agent may have restarted the Host behind its back, or a user/supervisor stopped it directly).'

  const content: { type: 'text'; text: string }[] = [{
    type: 'text',
    text: '<handoff_reminder>\n'
      + 'The DSH Host process restarted and this session was automatically recovered from its '
      + 'durable log. Your pre-restart "last will" is below.\n'
      + restartOrigin + '\n'
      + 'Required behavior:\n'
      + '1. Treat the current workspace, tool results, and durable session state as authoritative — '
      + 'inspect them instead of assuming earlier narration is still current.\n'
      + '2. If the will\'s objective/progress is already finished in the workspace, call `handoff_clear` '
      + 'to remove the record, then briefly report to the user what completed.\n'
      + '3. Otherwise continue the will\'s next_step: actually do the work now, not just acknowledge it.\n'
      + 'Either way, end your reply with an explicit one-line status line: "Restarted: <what this session '
      + 'was working on> — <continuing | completed>".\n'
      + 'Note: Host restarts are ONLY legitimate through the `handoff_at_restart` tool, which first lets '
      + 'every interrupted session record its will. If this restart was not requested that way, report '
      + 'it as unexpected and continue your work from the durable state.\n'
      + JSON.stringify(record, null, 2)
      + '\n</handoff_reminder>',
  }]
  if (note) content.push({ type: 'text', text: note })

  // Deliver one natural follow-up turn that wakes the driver, so the reminder
  // becomes the model's next input. `inject` would only queue context and never
  // start a turn on an idle resumed agent; `followup` is the DSH-native way to
  // start a model round on an idle agent (goal-round-driver uses the same call).
  agent.followup(createUserMessage({
    content,
    source: {
      kind: 'plugin',
      plugin: SOURCE_PLUGIN,
      form: 'notice',
      summary: boundContextSummary(`restart COMPLETED; session auto-recovered — ${objective}`),
    },
  }))

  // Delivered once: flip the pending flag so a later unrelated restart won't
  // re-remind the same already-surfaced task.
  writeHandoff(agent.id, { ...record, pending: false })
  return true
}

const SAVE_PARAMS = {
  objective: {
    type: 'string', required: true,
    description: 'The current goal / task being worked on when the restart cuts this session.',
  },
  progress: {
    type: 'string',
    description: 'What has been done so far.',
  },
  next_step: {
    type: 'string',
    description: 'What to do next after the Host restarts.',
  },
  goal_id: { type: 'string', description: 'Active goal id, if any.' },
  round: { type: 'number', description: 'Current goal round, if any.' },
  note: {
    type: 'string',
    description: 'Free-form note (e.g. running subagents / background jobs that call for follow-up).',
  },
} as const

const SAVE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      written: { type: 'boolean', required: true },
      file: { type: 'string' },
    },
  },
  render: (_args: unknown, value: { written: boolean; file?: string }) =>
    [{ type: 'text' as const, text: value.written ? `handoff written: ${value.file}` : 'handoff not written' }],
} as const

const CLEAR_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { cleared: { type: 'boolean', required: true } },
  },
  render: (_args: unknown, value: { cleared: boolean }) =>
    [{ type: 'text' as const, text: value.cleared ? 'handoff cleared' : 'no handoff to clear' }],
} as const

/** Auth a call's agent from the live registry, like the goal tools do. */
function callingAgent(ctx: Context, exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) throw new HarnessError('handoff tools require a calling agent', 'HANDOFF_AGENT_REQUIRED')
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running') {
    throw new HarnessError('handoff tools require the exact live calling agent', 'HANDOFF_DRIVER_REQUIRED')
  }
  return agent
}

/** Emit the settlement event for the current broadcast, if this agent is a target. */
function emitSettled(ctx: Context, agentId: string, outcome: HandoffSettledPayload['outcome']): void {
  const broadcast = activeBroadcast
  if (broadcast === null || !broadcast.targets.has(agentId)) return
  ctx.emit('handoff/settled', { agentId, requestId: broadcast.requestId, outcome })
}

/** Register the two model-facing tools and the restart reminder listener. */
export function apply(ctx: Context): void {
  /**
   * Agent ids currently RUNNING with their model route, maintained in real time
   * from `agent/status` events (set on `running`, deleted on `idle`). This is
   * the live definition of "a session a restart would interrupt". The teardown
   * safety net consumes it directly: it is a running fact, not a post-hoc
   * `agents.list()` query (which at teardown would see every agent already
   * cancelled to idle). The captured provider/model lets a fallback will
   * restore the session's model route on recovery.
   */
  const runningSessions = new Map<string, { provider?: string | undefined; model?: string | undefined; startedAt: number }>()
  ctx.tools.register(defineTool({
    name: 'handoff_save',
    description:
      'Write a durable "last will" (restart handoff) for the CURRENT session right before the DSH Host '
      + 'process is restarted. Use only right before a restart that would cut this session — a conversation '
      + 'that finished normally needs none. After the Host comes back and this session resumes, the harness '
      + 'automatically injects one continue-reminder built from this note. You may only ever write your own '
      + 'session handoff.',
    parameters: SAVE_PARAMS,
    output: SAVE_OUTPUT,
    execute(args: { objective: string; progress?: string; next_step?: string; goal_id?: string; round?: number; note?: string }, exec) {
      const agent = callingAgent(ctx, exec)
      if (typeof args.round === 'number' && (!Number.isSafeInteger(args.round) || args.round < 1)) {
        throw new HarnessError('round must be a positive safe integer', 'HANDOFF_INVALID_INPUT')
      }
      // Capture the session's own preset + model route so an auto-recover
      // mounts the same composition AND restores the model/provider (otherwise
      // the resumed session's persona `{{model}}` resolves empty → run fails).
      const agentPresets = ctx.get('agentPresets')
      const presetId = agentPresets?.composedPreset(agent.ctx)
      // A will written while this agent is a target of an in-flight broadcast
      // carries that broadcast's identity, so settlement can accept exactly the
      // records produced by the current restart request — never a stale record
      // from an earlier restart (the old-record misjudgment).
      const broadcast = activeBroadcast !== null && activeBroadcast.targets.has(agent.id)
        ? {
          requestId: activeBroadcast.requestId,
          requestedAt: activeBroadcast.requestedAt,
          initiatorId: activeBroadcast.initiatorId,
        }
        : undefined
      const record = {
        schema: 3,
        sessionId: agent.id,
        cwd: process.cwd(),
        objective: args.objective,
        progress: args.progress ?? '',
        nextStep: args.next_step ?? '',
        goalId: args.goal_id || undefined,
        round: args.round,
        note: args.note ?? '',
        presetId,
        provider: agent.options.provider,
        model: agent.options.model,
        wroteAt: new Date().toISOString(),
        ...(broadcast === undefined ? {} : {
          requestId: broadcast.requestId,
          requestedAt: broadcast.requestedAt,
          ...(broadcast.initiatorId === undefined ? {} : { initiatorId: broadcast.initiatorId }),
        }),
        pending: true,
      }
      writeHandoff(agent.id, record)
      emitSettled(ctx, agent.id, 'written')
      return Promise.resolve({ written: true, file: handoffPath(agent.id) })
    },
    presentCall: (args: { objective?: string }) => ({
      card: 'generic' as const, title: 'Save restart handoff', kind: 'other' as const,
      ...args?.objective ? { rawInput: args.objective } : {},
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'handoff_clear',
    description:
      'Clear the current session\'s restart handoff once its work has fully resumed or completed, so a later '
      + 'unrelated restart does not re-remind the same finished task. You may only clear your own session handoff.',
    parameters: {},
    output: CLEAR_OUTPUT,
    execute(_args: Record<string, never>, exec) {
      const agent = callingAgent(ctx, exec)
      let cleared = false
      try {
        fs.unlinkSync(handoffPath(agent.id))
        cleared = true
      } catch {
        cleared = false
      }
      // "Nothing in progress" is a valid settlement for an in-flight broadcast:
      // the agent deliberately decided no will is needed, so the broadcast can
      // count it as settled even though no file remains.
      emitSettled(ctx, agent.id, 'cleared')
      return Promise.resolve({ cleared })
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Clear restart handoff', kind: 'other' as const }),
  }))

  ctx.tools.register(defineTool({
    name: 'handoff_at_restart',
    description:
      'THIS IS THE ONLY LEGITIMATE WAY TO RESTART THE DSH HOST. Broadcast a "Restart is imminent, '
      + 'leave your handoff" request to every interruptible live agent, wait for each to settle its own '
      + 'handoff (write or clear), then trigger the supervisor to gracefully restart the Host. Use right '
      + 'before you (or an operator) intend to restart the DSH Host so that every still-working agent gets '
      + 'a chance to record its own "last will". Each agent writes its own handoff content; this tool does '
      + 'not fabricate it. Never restart the Host by killing the process, touching the supervisor request '
      + 'file, or any other means — the supervisor rejects unattested restarts and sessions would be cut '
      + 'without their will. If an agent does not settle within wait_seconds, the restart is NOT requested '
      + 'and the unconfirmed agents are reported instead.',
    parameters: {
      wait_seconds: {
        type: 'number',
        description: 'Seconds to wait for the broadcast agents to settle their handoffs before restart. Default 30.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          broadcast: { type: 'integer' }, waitSeconds: { type: 'number' },
          requestFile: { type: 'string' }, restarted: { type: 'boolean' },
          confirmed: { type: 'array', items: { type: 'string' } },
          unconfirmed: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a: unknown, v: { broadcast: number; waitSeconds: number; requestFile: string; restarted: boolean; confirmed: string[]; unconfirmed: string[] }) =>
        [{ type: 'text' as const, text: `broadcast to ${v.broadcast} interruptible agent(s), waited ${v.waitSeconds}s, ${v.restarted ? `restart requested (${v.confirmed.join(', ')})` : `NO restart (unconfirmed: ${v.unconfirmed.join(', ') || 'none'})`}` }],
    },
    execute(args: { wait_seconds?: number }, exec) {
      const agents = ctx.get('agents')
      const timer = ctx.get('timer')
      if (agents === undefined || timer === undefined) {
        return Promise.resolve({ broadcast: 0, waitSeconds: 0, requestFile: '', restarted: false, confirmed: [], unconfirmed: [] })
      }
      const selfId = exec.agent?.id
      const allAgents = agents.list()
      // Every OTHER live session that is running would be cut by a restart and
      // must leave a will first. The initiator is excluded — we never cancel or
      // re-request ourselves. Only agents actually `running` are targets: idle
      // sessions have no active driver to lose and would only be re-reminded
      // spuriously by a restart they did not ask for.
      const interruptible = allAgents.filter((a) => a.id !== selfId && a.status === 'running')
      const waitSeconds = typeof args.wait_seconds === 'number' && args.wait_seconds > 0
        ? Math.round(args.wait_seconds) : 120
      const requestFile = path.join(handoffDir(), '.restart-request')

      // No targets → nothing to wait for; the supervisor restart can proceed
      // immediately and no agent is cut without a will. The request file is
      // written as an attested restart record: supervisor only honours a file
      // whose `attested` flag is true and whose requestId is fresh, so a bare
      // `touch` (an agent restarting behind the broadcast's back) is ignored.
      if (interruptible.length === 0) {
        writeRestartRequest(requestFile, { attested: true, requestId: 'no-targets', requestedAt: Date.now(), initiator: selfId, confirmed: [], unconfirmed: [] })
        logAutoRecover(`handoff_at_restart: no interruptible agents; wrote ${requestFile} immediately`)
        return Promise.resolve({ broadcast: 0, waitSeconds, requestFile, restarted: true, confirmed: [], unconfirmed: [] })
      }
      if (activeBroadcast !== null) {
        return Promise.resolve({ broadcast: interruptible.length, waitSeconds, requestFile, restarted: false, confirmed: [], unconfirmed: interruptible.map(a => a.id) })
      }

      const requestId = randomUUID()
      const requestedAt = Date.now()
      activeBroadcast = {
        requestId,
        requestedAt,
        initiatorId: selfId,
        targets: new Set(interruptible.map(a => a.id)),
      }
      const confirmed = new Set<string>()
      logAutoRecover(`handoff_at_restart: broadcast ${requestId} opened for ${interruptible.length} agent(s), wait up to ${waitSeconds}s`)

      const run = async (): Promise<{ broadcast: number; waitSeconds: number; requestFile: string; restarted: boolean; confirmed: string[]; unconfirmed: string[] }> => {
        // Settlement is event-driven end to end: `handoff_save` / `handoff_clear`
        // emit `handoff/settled`, and the listener below resolves the wait
        // promise the moment every target has settled. No polling loop ever
        // re-reads files or ticks a timer to discover progress.
        let resolveAll: () => void = () => {}
        const allSettled = new Promise<void>(resolve => { resolveAll = resolve })
        // Listen for settlements BEFORE sending any request, so no event can
        // slip between request and listener registration.
        const settled = (payload: HandoffSettledPayload): void => {
          if (payload.requestId !== requestId) return
          confirmed.add(payload.agentId)
          logAutoRecover(`handoff_at_restart: ${payload.agentId} settled (${payload.outcome})`)
          if (confirmed.size >= interruptible.length) resolveAll()
        }
        const dispose = ctx.on('handoff/settled', settled)
        try {
          // 1) End the agent's current task so it converges to idle.
          //    keepInbox preserves any queued input so it can still be
          //    seen/claimed after the cancel.
          for (const a of interruptible) {
            try {
              a.cancel({ kind: 'parent' }, { keepInbox: true })
            } catch (e) {
              logAutoRecover(`handoff_at_restart: cancel ${a.id} failed: ${String((e as Error)?.message ?? e)}`)
            }
          }
          // 2) Await each agent's true quiescence (not merely "cancel
          //    requested") before sending its independent handoff turn, closing
          //    the cancel/send race: the turn must land on an agent that has
          //    actually reached idle, never on one still converging from a
          //    cancelled activity. Bounded so a single stuck agent cannot hang
          //    the whole broadcast past the wait budget.
          await Promise.allSettled(interruptible.map(a =>
            Promise.race([
              a.whenIdle(),
              timer.timeout(Math.min(5000, Math.max(1000, waitSeconds * 1000))),
            ]),
          ))
          // 3) Send ONE independent handoff turn per agent: an ordinary
          //    follow-up turn whose sole message is the handoff request. The
          //    agent's model round then calls handoff_save / handoff_clear,
          //    which emit the settlement event we are listening for.
          for (const a of interruptible) {
            try {
              a.followup(createUserMessage({
                content: [{
                  type: 'text',
                  text: '<handoff_request>\n'
                    + 'The DSH Host is about to restart NOW, through the ONLY legitimate restart path '
                    + '(`handoff_at_restart`). Your current task has been stopped so you can record your own '
                    + '"last will" first. Call `handoff_save` immediately with your objective, progress, and '
                    + 'next step.\n'
                    + 'Guidance:\n'
                    + '- objective: what you are working on (or "nothing in progress" if truly done).\n'
                    + '- next_step: the FIRST concrete action you will take after restart — it will be '
                    + 'delivered to you as an automatic reminder, and you are expected to actually do it.\n'
                    + '- After restart, if you find the work already complete, call `handoff_clear` to remove '
                    + 'the record instead of leaving it stale.\n'
                    + 'A finished conversation needs none. Only you may write your own handoff.\n'
                    + '- If you truly have nothing in progress, call `handoff_clear` so the broadcast knows '
                    + 'you need no will.\n'
                    + '- IMPORTANT: the Host MUST only ever be restarted via `handoff_at_restart`. Never '
                    + 'restart it by killing the process or touching the supervisor file; unattested '
                    + 'restarts cut sessions without their will and are rejected by the supervisor.\n</handoff_request>',
                }],
                source: { kind: 'plugin', plugin: SOURCE_PLUGIN, form: 'notice', summary: 'restart PENDING — please leave your handoff' },
              }))
            } catch (e) {
              logAutoRecover(`handoff_at_restart: followup ${a.id} failed: ${String((e as Error)?.message ?? e)}`)
            }
          }
          // 4) Wait until every target has settled or the wait budget elapses.
          //    Pure event race: `allSettled` resolves only from a settlement
          //    event; the timer is the single deadline that releases the tool
          //    when an agent never responds.
          await Promise.race([
            allSettled,
            timer.timeout(waitSeconds * 1000),
          ])
          const unconfirmed = interruptible.filter(a => !confirmed.has(a.id))
          if (unconfirmed.length === 0) {
            // Every target settled: commit the restart. Only now is the
            // supervisor's trigger file written, so a restart never cuts a
            // working agent without its will (no incomplete restart). The
            // attested record carries the broadcast identity so supervisor can
            // reject a bare `touch` restart that never ran the broadcast.
            writeRestartRequest(requestFile, { attested: true, requestId, requestedAt, initiator: selfId, confirmed: [...confirmed], unconfirmed: [] })
            logAutoRecover(`handoff_at_restart: all ${interruptible.length} agent(s) settled; wrote ${requestFile}`)
            return { broadcast: interruptible.length, waitSeconds, requestFile, restarted: true, confirmed: [...confirmed], unconfirmed: [] }
          }
          // Budget elapsed with unconfirmed targets: DO NOT restart. Report the
          // unconfirmed agents so the caller can decide (retry with more time,
          // investigate, or force a restart some other way).
          logAutoRecover(`handoff_at_restart: budget elapsed; NO restart (unconfirmed: ${unconfirmed.map(a => a.id).join(', ')})`)
          return { broadcast: interruptible.length, waitSeconds, requestFile, restarted: false, confirmed: [...confirmed], unconfirmed: unconfirmed.map(a => a.id) }
        } finally {
          dispose()
          activeBroadcast = null
          logAutoRecover(`handoff_at_restart: broadcast ${requestId} closed`)
        }
      }
      return run()
    },
    presentCall: () => ({ card: 'generic' as const, title: 'Broadcast handoff request + restart', kind: 'other' as const }),
  }))

  // Deliver a pending handoff exactly once, at the DSH-native "ready for a
  // round" moment: when the agent reaches idle. This mirrors goal-round-driver,
  // which wakes an idle agent with `agent.followup`. A pending handoff file is
  // the condition; after followup it is flipped to done so it never re-fires.
  // Two guards keep a freshly written will from being consumed before its
  // intended restart:
  //   1. While a handoff_at_restart broadcast is in flight, delivery is
  //      suppressed entirely (agents idle-toggle as they write their wills).
  //   2. Only handoffs written before THIS host started are eligible. A will
  //      written during this host's life is for the NEXT restart; delivering
  //      and clearing it now robs post-restart auto-recover of its pending
  //      record — the observed "wrote a will, consumed immediately, restart,
  //      never recovered" bug.
  // Track which agents are CURRENTLY running as a live, event-driven fact.
  // On the `running` transition the durable snapshot is written SYNCHRONOUSLY
  // — before any shutdown cancel can fire the `idle` events that would empty
  // an in-memory set (a graceful shutdown cancels every running agent to idle,
  // so a teardown-time in-memory read is always empty — the observed miss).
  // The `idle` transition updates memory only and never shrinks the durable
  // snapshot, because an idle event during shutdown is the cancel, not
  // evidence the session was safe to drop. The teardown safety net and
  // auto-recover both consume the durable snapshot, so "running when this host
  // died" survives even a hard kill with no teardown at all.
  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: string }) => {
    if (status === 'running') {
      const now = Date.now()
      runningSessions.set(agent.id, { provider: agent.options.provider, model: agent.options.model, startedAt: now })
      writeRunningSnapshot(runningSessions)
    } else if (status === 'idle') {
      runningSessions.delete(agent.id)
      logAutoRecover(`agent ${agent.id} idle → check handoff`)
      if (activeBroadcast !== null) {
        logAutoRecover(`agent ${agent.id} idle during broadcast window → delivery suppressed (will stays pending for post-restart recovery)`)
        return
      }
      const record = readHandoff(agent.id)
      if (record !== undefined) {
        const wroteAt = typeof record.wroteAt === 'string' ? Date.parse(record.wroteAt) : NaN
        if (Number.isFinite(wroteAt) && wroteAt >= HOST_START_EPOCH) {
          logAutoRecover(`agent ${agent.id} idle with a handoff written during THIS host life (wroteAt=${record.wroteAt}) → delivery suppressed (will stays pending for the next restart)`)
          return
        }
      }
      deliverPendingHandoff(agent)
    }
  })

  // Auto-recover: when the Host starts, resume any session that left an
  // unconsumed (pending) handoff, so a restart actually continues the work
  // without the user having to reopen the conversation by hand. That resume
  // publishes the agent, which eventually reaches idle, where the listener
  // above wakes it with the reminder.
  // Scheduled a short while after apply so the host registries are ready.
  logAutoRecover(`apply registered (name=${name}, inject=${inject.join(',')})`)
  const timer = ctx.get('timer')
  if (timer !== undefined) {
    logAutoRecover('scheduling autoRecoverSkipped in 1500ms')
    timer.timeout(() => { void autoRecoverSkipped(ctx) }, 1500)
  } else {
    logAutoRecover('timer service unavailable; auto-recover NOT scheduled')
  }

  // Safety net: whenever THIS Host is being torn down — graceful SIGTERM from
  // the supervisor, a user-triggered restart, or an agent that restarted the
  // Host behind the broadcast's back — write a fallback pending will for every
  // agent that was RUNNING during this host life and has none. It reads the
  // DURABLE snapshot, not the in-memory set: a graceful shutdown cancels every
  // running agent to idle, which empties the in-memory set before teardown
  // runs (the observed miss); the snapshot was written on each `running`
  // transition, before any cancel, so it still names every session a restart
  // actually interrupted. Entries started before this host's life are stale
  // leftovers and skipped. The writes are synchronous so they complete inside
  // the supervisor's 5s disposal grace.
  ctx.effect(() => () => {
    try {
      const snapshot = readRunningSnapshot()
      if (snapshot === undefined || snapshot.size === 0) return
      const now = new Date().toISOString()
      for (const [sessionId, route] of snapshot) {
        if (route.startedAt < HOST_START_EPOCH) continue
        try {
          const existing = readHandoff(sessionId)
          if (existing !== undefined && existing.pending === true) continue
          writeHandoff(sessionId, {
            schema: 3,
            sessionId,
            cwd: process.cwd(),
            objective: 'Host restarted while this session was running',
            progress: 'Interrupted mid-task by a Host restart that did not run the handoff broadcast.',
            nextStep: 'Inspect the current workspace and durable session state to determine where the work stopped, then continue it.',
            provider: route.provider,
            model: route.model,
            wroteAt: now,
            pending: true,
            fallback: true,
          })
          logAutoRecover(`fallback will written for ${sessionId} at teardown`)
        } catch (e) {
          logAutoRecover(`fallback will FAILED for ${sessionId}: ${String((e as Error)?.message ?? e)}`)
        }
      }
    } catch { /* teardown diagnostics must never throw */ }
  }, 'handoff-teardown-fallback')
}

/** Append an observable diagnostic line to <DSH_HOME>/.handoff/auto-recover.log. */
function logAutoRecover(line: string): void {
  try {
    const logPath = path.join(handoffDir(), 'auto-recover.log')
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* diagnostics must never crash the loop */ }
}

/**
 * Durable "recently running" snapshot path. Written synchronously every time
 * an agent transitions to `running` — BEFORE any shutdown cancel can fire the
 * `idle` events that would empty an in-memory set. This is the authoritative
 * "which sessions were running when this host died" record: a graceful
 * shutdown cancels every running agent to idle, so an in-memory set read at
 * teardown would already be empty (the observed miss). The snapshot is written
 * on the running transition itself and never shrunk by idle events, so a
 * restart — graceful or hard — can always recover every session that was
 * running during this host life.
 */
const RUNNING_SNAPSHOT = 'running-sessions.json'

/** Read the durable recently-running snapshot, or undefined when absent. */
function readRunningSnapshot(): Map<string, { provider?: string | undefined; model?: string | undefined; startedAt: number }> | undefined {
  try {
    const raw = fs.readFileSync(path.join(handoffDir(), RUNNING_SNAPSHOT), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const map = new Map<string, { provider?: string | undefined; model?: string | undefined; startedAt: number }>()
    for (const [id, entry] of Object.entries(parsed as Record<string, { provider?: string; model?: string; startedAt?: number }>)) {
      if (typeof entry?.startedAt === 'number') {
        map.set(id, { provider: entry.provider, model: entry.model, startedAt: entry.startedAt })
      }
    }
    return map
  } catch {
    return undefined
  }
}

/** Persist the snapshot synchronously (temp + rename). */
function writeRunningSnapshot(snapshot: Map<string, { provider?: string | undefined; model?: string | undefined; startedAt: number }>): void {
  try {
    const file = path.join(handoffDir(), RUNNING_SNAPSHOT)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const obj: Record<string, { provider?: string | undefined; model?: string | undefined; startedAt: number }> = {}
    for (const [id, entry] of snapshot) {
      obj[id] = { ...entry, startedAt: entry.startedAt }
    }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, file)
  } catch { /* snapshot persistence must never crash the loop */ }
}

/**
 * Write the supervisor's restart trigger as an ATTESTED record. The file is
 * JSON, not a bare touch: supervisor honours only a record with
 * `attested: true` and a recent `requestedAt`, so a bare `touch .restart-request`
 * (an agent restarting the Host behind the broadcast's back) is ignored and no
 * live session is ever cut without its will.
 * @param requestFile - the supervisor restart-trigger path.
 * @param record - attested broadcast facts.
 */
function writeRestartRequest(requestFile: string, record: {
  attested: true
  requestId: string
  requestedAt: number
  initiator?: string | undefined
  confirmed: string[]
  unconfirmed: string[]
}): void {
  fs.mkdirSync(path.dirname(requestFile), { recursive: true })
  fs.writeFileSync(requestFile, JSON.stringify(record, null, 2), 'utf8')
}

/** After host start, resume sessions that own a pending handoff.
 * @param ctx - the mounting context whose agents/presets drive resume.
 */
export async function autoRecoverSkipped(ctx: Context): Promise<void> {
  logAutoRecover('autoRecoverSkipped invoked')
  const agents = ctx.get('agents')
  const agentPresets = ctx.get('agentPresets')
  if (agents === undefined || agentPresets === undefined) {
    logAutoRecover(`aborted: agents=${String(agents !== undefined)} agentPresets=${String(agentPresets !== undefined)}`)
    return
  }

  let files: string[]
  try {
    files = fs.readdirSync(handoffDir()).filter(f => f.endsWith('.json'))
    logAutoRecover(`handoff files found: ${files.length}`)
  } catch (error) {
    logAutoRecover(`no handoff dir (${handoffDir()}): ${String((error as Error)?.message ?? error)}`)
    return // no handoff directory yet → nothing to recover
  }

  // Snap-shot sessions that were RUNNING during the PREVIOUS host life but
  // left no handoff will (a restart that never ran the broadcast — graceful
  // SIGTERM, user button, or an agent restarting behind the broadcast's back).
  // Materialize a fallback will for each so the scan below recovers them too;
  // the snapshot was written on each `running` transition BEFORE any shutdown
  // cancel could empty an in-memory set, so it is the authoritative "what was
  // running when the previous host died" record.
  try {
    const snapshot = readRunningSnapshot()
    if (snapshot !== undefined) {
      for (const [sessionId, route] of snapshot) {
        if (route.startedAt >= HOST_START_EPOCH) continue // this host's own entries: for the NEXT restart
        const existing = readHandoff(sessionId)
        if (existing !== undefined && existing.pending === true) continue
        writeHandoff(sessionId, {
          schema: 3,
          sessionId,
          cwd: process.cwd(),
          objective: 'Host restarted while this session was running',
          progress: 'Interrupted mid-task by a Host restart that did not run the handoff broadcast.',
          nextStep: 'Inspect the current workspace and durable session state to determine where the work stopped, then continue it.',
          provider: route.provider,
          model: route.model,
          // Timestamp with the session's own RUNNING time (a PAST time from
          // the previous host life), not now: the scan below only recovers
          // wills written BEFORE this host started, and a fallback will with a
          // current `wroteAt` would be misread as "written during THIS host
          // life" and skipped.
          wroteAt: new Date(route.startedAt).toISOString(),
          pending: true,
          fallback: true,
        })
        logAutoRecover(`fallback will materialized from snapshot for ${sessionId}`)
      }
    }
  } catch (e) {
    logAutoRecover(`snapshot materialization FAILED: ${String((e as Error)?.message ?? e)}`)
  }

  // Drop the consumed snapshot: every recovered session now has a pending will
  // of its own, and a stale snapshot would mislead the NEXT host life.
  try {
    fs.rmSync(path.join(handoffDir(), RUNNING_SNAPSHOT), { force: true })
  } catch { /* snapshot cleanup is best-effort */ }

  // Re-read the directory: snapshot materialization just wrote fallback wills
  // that the first readdir (taken before materialization) does not contain.
  try {
    files = fs.readdirSync(handoffDir()).filter(f => f.endsWith('.json'))
    logAutoRecover(`handoff files after snapshot materialization: ${files.length}`)
  } catch { /* directory still exists; keep the earlier list */ }
  for (const file of files) {
    const sessionId = file.replace(/\.json$/, '')
    try {
      const record = readHandoff(sessionId)
      if (record === undefined || record.pending !== true) { logAutoRecover(`skip ${sessionId}: no pending record`); continue }
      // Only recover wills left by a PREVIOUS host life. A will written during
      // this host's life (e.g. by a just-started agent) is destined for the
      // NEXT restart; resuming its owner now would both double-deliver and
      // mark it consumed before the restart it was written for.
      const wroteAt = typeof record.wroteAt === 'string' ? Date.parse(record.wroteAt) : NaN
      if (Number.isFinite(wroteAt) && wroteAt >= HOST_START_EPOCH) {
        logAutoRecover(`skip ${sessionId}: handoff written during THIS host life (wroteAt=${record.wroteAt}) → reserved for the next restart`)
        continue
      }
      logAutoRecover(`found pending handoff ${sessionId}`)
      // Only recover sessions that aren't already live.
      if (agents.get(sessionId as SessionId) !== undefined) {
        logAutoRecover(`skip ${sessionId}: already live`)
        continue
      }

      const presetId = typeof record.presetId === 'string' ? record.presetId : undefined
      // Restore the session's model route so its persona `{{model}}` resolves;
      // otherwise the resumed session fails at persona assembly (model empty).
      const provider = typeof record.provider === 'string' ? record.provider : undefined
      const model = typeof record.model === 'string' ? record.model : undefined
      logAutoRecover(`resuming ${sessionId} ${presetId === undefined ? '(default preset)' : `(preset ${presetId})`} model=${model ?? 'unset'}`)
      const setup = async (agentCtx: Context): Promise<void> => {
        if (presetId !== undefined) {
          await agentPresets.mount(agentCtx, presetId)
        } else {
          await agentPresets.mount(agentCtx)
        }
      }
      const handle = provider !== undefined && model !== undefined
        ? await agents.resume({ resumeSessionId: sessionId as SessionId, agentOptions: { provider, model }, setup })
        : await agents.resume({ resumeSessionId: sessionId as SessionId, setup })
      logAutoRecover(`resume ${sessionId}: OK`)
      // Deliver only after the resumed driver reaches true quiescence. A
      // session recovered from a PREVIOUS host life may still have an
      // unfinished tool round whose async output stream keeps appending to the
      // durable log after publish; injecting the reminder immediately would
      // race that stream for the next sequence number and corrupt the log
      // (observed: seq-gap damage on two sessions resumed during a mid-round
      // host crash). Await the new driver's quiescence plus a short silence
      // window so a still-appending old stream drains before the reminder
      // opens a fresh turn. Bounded so one stuck agent cannot hang the whole
      // recovery pass.
      const timer = ctx.get('timer')
      if (timer !== undefined) {
        await Promise.race([
          handle.agent.whenIdle(),
          timer.timeout(Math.min(10_000, Math.max(1_000, 5_000))),
        ])
        await timer.timeout(250)
      }
      deliverPendingHandoff(handle.agent)
    } catch (error) {
      logAutoRecover(`resume ${sessionId} FAILED: ${String((error as Error)?.stack ?? error)}`)
      // Session may not exist / not resumable; skip rather than crash startup.
      console.warn(`dsh-handoff: auto-resume ${sessionId} skipped: ${String((error as Error).message ?? error)}`)
    }
  }
  logAutoRecover('autoRecoverSkipped done')
}
