import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as handoff from '@deepseek-ai/dsh-handoff'

const testToolSignal = new AbortController().signal

/** A registry-compatible live agent; `followup` records what was sent. */
function stubAgent(rawId: string): {
  agent: Agent
  session: Session
  setStatus(status: AgentStatus): void
  sent: string[]
} {
  const session = Session.create(SessionId(rawId))
  let status: AgentStatus = 'running'
  const sent: string[] = []
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: (message) => {
      const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
      sent.push(text)
    },
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, session, setStatus(value) { status = value }, sent }
}

/** Register the plugin's host context with its required services. */
async function harness(overrides: { agentPresets?: unknown; resume?: unknown } = {}) {
  const ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  // `inject` declares goals + agentPresets as hard dependencies, so the plugin
  // waits for them before apply; the handoff tools only read them optionally.
  ctx.provide('goals', { get: () => undefined })
  ctx.provide('agentPresets', overrides.agentPresets ?? {
    composedPreset: () => undefined, mount: async () => {},
  })
  const agentsService = ctx.get('agents')
  if (overrides.resume !== undefined) {
    ;(agentsService as { resume: unknown }).resume = overrides.resume
  }
  const fiber = await ctx.plugin(handoff)
  return { ctx, fiber }
}

/** Execute one registered tool for the given agent (must be running). */
async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent: Agent,
): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${randomUUID()}`),
    name,
    arguments: args,
    agent,
  })
}

/** Read the value returned by a successful tool (not its rendered text). */
function resultJson(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected tool success')
  const value = result.value
  if (typeof value !== 'object' || value === null) throw new Error('expected object tool value')
  return value as Record<string, unknown>
}

let dshHome: string
let handoffDir: string

/** Read the attested restart-request record, or undefined when absent/invalid. */
function restartRequest(): Record<string, unknown> | undefined {
  const file = path.join(handoffDir, '.restart-request')
  if (!fs.existsSync(file)) return undefined
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

beforeEach(() => {
  dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handoff-test-'))
  handoffDir = path.join(dshHome, '.handoff')
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  delete process.env.DSH_HOME
  fs.rmSync(dshHome, { recursive: true, force: true })
})

describe('handoff registration and presentation', () => {
  it('registers three tools and disposes all contributions', async () => {
    const { ctx, fiber } = await harness()
    expect(['handoff_save', 'handoff_clear', 'handoff_at_restart'].map(name => ctx.tools.get(name)?.name))
      .toEqual(['handoff_save', 'handoff_clear', 'handoff_at_restart'])

    await fiber.dispose()
    expect(ctx.tools.get('handoff_save')).toBeUndefined()
    expect(ctx.tools.get('handoff_clear')).toBeUndefined()
    expect(ctx.tools.get('handoff_at_restart')).toBeUndefined()
  })

  it('has the Loader-safe namespace export shape', () => {
    expect('default' in handoff).toBe(false)
    expect(handoff.name).toBe('tool-handoff')
    expect(handoff.inject).toEqual(['tools', 'agents', 'agentPresets', 'timer'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(handoff)).toBe(handoff)
  })

  it('uses generic render intents and soft-fails malformed replay args', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.get('handoff_save')?.presentCall?.({ objective: 'ship' })).toEqual({
      card: 'generic', title: 'Save restart handoff', kind: 'other', rawInput: 'ship',
    })
    expect(ctx.tools.get('handoff_clear')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'Clear restart handoff', kind: 'other',
    })
    expect(ctx.tools.get('handoff_at_restart')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'Broadcast handoff request + restart', kind: 'other',
    })
  })
})

describe('handoff_save / handoff_clear', () => {
  it('writes a durable pending record and clears it', async () => {
    const { ctx } = await harness()
    const { agent, session, setStatus } = stubAgent('save-root')
    ctx.agents.register(agent)
    setStatus('running')

    const file = path.join(handoffDir, `${agent.id}.json`)
    expect(fs.existsSync(file)).toBe(false)

    const saved = await execute(ctx, 'handoff_save', { objective: 'finish x', progress: 'half', next_step: 'continue' }, agent)
    const savedJson = resultJson(saved)
    expect(savedJson.written).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(record.sessionId).toBe(agent.id)
    expect(record.objective).toBe('finish x')
    expect(record.pending).toBe(true)
    expect(record.schema).toBe(3)

    const cleared = await execute(ctx, 'handoff_clear', {}, agent)
    expect(resultJson(cleared).cleared).toBe(true)
    expect(fs.existsSync(file)).toBe(false)

    // clear of an absent file is a soft false, not an error
    const again = await execute(ctx, 'handoff_clear', {}, agent)
    expect(resultJson(again).cleared).toBe(false)
    expect(session.id).toBe(agent.id)
  })

  it('rejects a non-positive round', async () => {
    const { ctx } = await harness()
    const { agent, setStatus } = stubAgent('round-root')
    ctx.agents.register(agent)
    setStatus('running')
    const result = await execute(ctx, 'handoff_save', { objective: 'x', round: 0 }, agent)
    expect(result.isError).toBe(true)
  })

  it('requires the exact live calling agent', async () => {
    const { ctx } = await harness()
    const { agent } = stubAgent('ghost-root')
    const result = await execute(ctx, 'handoff_save', { objective: 'x' }, agent)
    expect(result.isError).toBe(true)
  })
})

describe('handoff_at_restart broadcast (event-driven)', () => {
  it('writes the restart file immediately when no interruptible agent exists', async () => {
    const { ctx } = await harness()
    const { agent, setStatus } = stubAgent('only-root')
    ctx.agents.register(agent)
    setStatus('running')

    const result = await execute(ctx, 'handoff_at_restart', {}, agent)
    const json = resultJson(result)
    expect(json.broadcast).toBe(0)
    expect(json.restarted).toBe(true)
    // The restart trigger is an ATTESTED record, never a bare touch.
    const request = restartRequest()
    expect(request?.attested).toBe(true)
    expect(typeof request?.requestId).toBe('string')
  })

  it('cancels each target, awaits quiescence, sends one independent turn, and settles via event', async () => {
    const { ctx } = await harness()
    const { agent: root, setStatus: setRoot } = stubAgent('broadcast-root')
    ctx.agents.register(root)
    setRoot('running')
    const { agent: target, setStatus: setTarget, sent } = stubAgent('target-1')
    ctx.agents.register(target)
    setTarget('running')

    const cancels: string[] = []
    const idles: string[] = []
    const originalCancel = target.cancel.bind(target)
    const originalWhenIdle = target.whenIdle.bind(target)
    target.cancel = (cause, options) => { cancels.push(cause.kind); originalCancel(cause, options) }
    target.whenIdle = () => { idles.push(target.id); return originalWhenIdle() }

    // The tool returns a promise; it must complete after the target settles.
    const pending = execute(ctx, 'handoff_at_restart', { wait_seconds: 5 }, root)

    // Give the synchronous cancel/quiescence/send path a microtask to run.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cancels).toEqual(['parent'])
    expect(idles).toEqual(['target-1'])
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('<handoff_request>')

    // The target settles by writing its own will — emits the settlement event.
    setTarget('running')
    const saved = await execute(ctx, 'handoff_save', { objective: 'target work' }, target)
    expect(resultJson(saved).written).toBe(true)

    const json = resultJson(await pending)
    expect(json.restarted).toBe(true)
    expect(json.confirmed).toEqual(['target-1'])
    expect(json.unconfirmed).toEqual([])
    const request = restartRequest()
    expect(request?.attested).toBe(true)
    expect(request?.confirmed).toEqual(['target-1'])
    // The will stays pending for post-restart recovery (no idle-consumption).
    const record = JSON.parse(fs.readFileSync(path.join(handoffDir, `${target.id}.json`), 'utf8')) as Record<string, unknown>
    expect(record.pending).toBe(true)
    expect(typeof record.requestId).toBe('string')
  })

  it('does NOT restart when a target never settles within the budget', async () => {
    const { ctx } = await harness()
    const { agent: root, setStatus: setRoot } = stubAgent('timeout-root')
    ctx.agents.register(root)
    setRoot('running')
    const { agent: target, setStatus: setTarget } = stubAgent('never-settles')
    ctx.agents.register(target)
    setTarget('running')

    const json = resultJson(await execute(ctx, 'handoff_at_restart', { wait_seconds: 1 }, root))
    expect(json.restarted).toBe(false)
    expect(json.confirmed).toEqual([])
    expect(json.unconfirmed).toEqual(['never-settles'])
    expect(fs.existsSync(path.join(handoffDir, '.restart-request'))).toBe(false)
  })

  it('ignores a settlement that belongs to an earlier/foreign broadcast (stale-record guard)', async () => {
    const { ctx } = await harness()
    const { agent: root, setStatus: setRoot } = stubAgent('stale-root')
    ctx.agents.register(root)
    setRoot('running')
    const { agent: target, setStatus: setTarget } = stubAgent('stale-target')
    ctx.agents.register(target)
    setTarget('running')

    const pending = execute(ctx, 'handoff_at_restart', { wait_seconds: 2 }, root)
    await new Promise(resolve => setTimeout(resolve, 20))

    // A stale record exists on disk from an earlier restart, and an event with
    // a foreign requestId arrives — neither may count as this broadcast's
    // settlement.
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, `${target.id}.json`), JSON.stringify({
      sessionId: target.id, objective: 'old will', pending: true,
      wroteAt: new Date(Date.now() - 3600_000).toISOString(), requestId: 'stale-request',
    }))
    ctx.emit('handoff/settled', { agentId: target.id, requestId: 'stale-request', outcome: 'written' })

    const json = resultJson(await pending)
    expect(json.restarted).toBe(false)
    expect(json.confirmed).toEqual([])
    expect(json.unconfirmed).toEqual(['stale-target'])
    expect(fs.existsSync(path.join(handoffDir, '.restart-request'))).toBe(false)
  })

  it('accepts a deliberate clear as settlement', async () => {
    const { ctx } = await harness()
    const { agent: root, setStatus: setRoot } = stubAgent('clear-root')
    ctx.agents.register(root)
    setRoot('running')
    const { agent: target, setStatus: setTarget } = stubAgent('clear-target')
    ctx.agents.register(target)
    setTarget('running')

    const pending = execute(ctx, 'handoff_at_restart', { wait_seconds: 5 }, root)
    await new Promise(resolve => setTimeout(resolve, 20))

    setTarget('running')
    await execute(ctx, 'handoff_clear', {}, target)

    const json = resultJson(await pending)
    expect(json.restarted).toBe(true)
    expect(json.confirmed).toEqual(['clear-target'])
    expect(restartRequest()?.attested).toBe(true)
  })

  it('excludes the initiator from its own broadcast', async () => {
    const { ctx } = await harness()
    const { agent: root, setStatus: setRoot } = stubAgent('self-root')
    ctx.agents.register(root)
    setRoot('running')
    const { agent: target, setStatus: setTarget } = stubAgent('other')
    ctx.agents.register(target)
    setTarget('running')

    const pending = execute(ctx, 'handoff_at_restart', { wait_seconds: 5 }, root)
    await new Promise(resolve => setTimeout(resolve, 20))

    // The initiator itself settles — that must NOT count toward the broadcast.
    setRoot('running')
    await execute(ctx, 'handoff_save', { objective: 'my own will' }, root)

    // The actual target settles.
    setTarget('running')
    await execute(ctx, 'handoff_save', { objective: 'other will' }, target)

    const json = resultJson(await pending)
    expect(json.confirmed).toEqual(['other'])
    expect(json.restarted).toBe(true)
  })
})

describe('deliver + auto-recover', () => {
  it('delivers a pre-host pending handoff once via followup and flips pending', async () => {
    const { ctx } = await harness()
    const { agent, sent } = stubAgent('deliver-root')
    ctx.agents.register(agent)

    // A handoff written BEFORE this host started (older than module load).
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, `${agent.id}.json`), JSON.stringify({
      sessionId: agent.id, objective: 'resume me', pending: true,
      wroteAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
    }))
    ctx.emit('agent/status', { agent, status: 'idle' })
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('<handoff_reminder>')
    // No initiator recorded → the reminder must flag the restart as UNEXPECTED
    // (not routed through handoff_at_restart) and require the only-legitimate
    // restart path.
    expect(sent[0]).toContain('UNEXPECTED')
    expect(sent[0]).toContain('handoff_at_restart')
    const record = JSON.parse(fs.readFileSync(path.join(handoffDir, `${agent.id}.json`), 'utf8')) as Record<string, unknown>
    expect(record.pending).toBe(false)

    // A second idle must NOT re-deliver.
    ctx.emit('agent/status', { agent, status: 'idle' })
    expect(sent.length).toBe(1)
  })

  it('names the broadcast initiator in the reminder when a will records it', async () => {
    const { ctx } = await harness()
    const { agent, sent } = stubAgent('initiator-root')
    ctx.agents.register(agent)
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, `${agent.id}.json`), JSON.stringify({
      sessionId: agent.id, objective: 'resume with origin', pending: true,
      wroteAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
      initiatorId: 'the-initiating-session',
    }))
    ctx.emit('agent/status', { agent, status: 'idle' })
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('the-initiating-session')
    // A will WITH an initiator must NOT be flagged as unexpected.
    expect(sent[0]).not.toContain('UNEXPECTED')
  })

  it('suppresses delivery while a broadcast window is open', async () => {
    const { ctx } = await harness()
    const { agent: root, setStatus: setRoot } = stubAgent('win-root')
    ctx.agents.register(root)
    setRoot('running')
    const { agent: target, setStatus: setTarget, sent } = stubAgent('win-target')
    ctx.agents.register(target)
    setTarget('running')

    const pending = execute(ctx, 'handoff_at_restart', { wait_seconds: 5 }, root)
    await new Promise(resolve => setTimeout(resolve, 20))

    // The broadcast sent the target one independent handoff REQUEST turn.
    expect(sent.length).toBe(1)
    expect(sent[0]).toContain('<handoff_request>')

    // The target idles after receiving the request; the open window must
    // suppress the idle→deliver path so the will survives post-restart
    // recovery — no reminder may be followup'd during the window.
    setTarget('idle')
    ctx.emit('agent/status', { agent: target, status: 'idle' })
    expect(sent.filter(text => text.includes('<handoff_reminder>')).length).toBe(0)

    setTarget('running')
    await execute(ctx, 'handoff_save', { objective: 'will during window' }, target)
    await pending
    expect(sent.filter(text => text.includes('<handoff_reminder>')).length).toBe(0)
  })

  it('auto-recover resumes a pending pre-host session with its preset/model', async () => {
    const mountCalls: string[] = []
    const reminderSent: string[] = []
    let published: Agent | undefined
    const { ctx } = await harness({
      agentPresets: {
        composedPreset: () => undefined,
        mount: async (_agentCtx: Context, preset?: string) => { mountCalls.push(preset ?? '(default)') },
      },
      resume: async (opts: { resumeSessionId: SessionId; setup?: (agentCtx: Context) => Promise<void> }): Promise<{ agent: Agent }> => {
        const { agent } = stubAgent(opts.resumeSessionId)
        agent.followup = (message) => {
          reminderSent.push(message.content.map(b => b.type === 'text' ? b.text : '').join(''))
        }
        published = agent
        // A real resume mounts the composition before publishing the agent.
        await opts.setup?.(agent.ctx)
        return { agent }
      },
    })
    const resumedId = 'recover-me'
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, `${resumedId}.json`), JSON.stringify({
      sessionId: resumedId, objective: 'recover', pending: true,
      wroteAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
      presetId: 'cordis', provider: 'deepseek', model: 'deepseek-v4-flash',
    }))

    await handoff.autoRecoverSkipped(ctx)

    expect(mountCalls).toEqual(['cordis'])
    expect(published).toBeDefined()
    expect(reminderSent.length).toBe(1)
    expect(reminderSent[0]).toContain('<handoff_reminder>')
    // Delivered once: pending flipped.
    const record = JSON.parse(fs.readFileSync(path.join(handoffDir, `${resumedId}.json`), 'utf8')) as Record<string, unknown>
    expect(record.pending).toBe(false)
  })

  it('skips a handoff written during this host life (reserved for the next restart)', async () => {
    const resumeCalls: unknown[] = []
    const { ctx } = await harness({
      resume: async (o: unknown) => { resumeCalls.push(o); return { agent: stubAgent('x').agent } },
    })
    const resumedId = 'skip-fresh'
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, `${resumedId}.json`), JSON.stringify({
      sessionId: resumedId, objective: 'fresh', pending: true,
      wroteAt: new Date().toISOString(),
    }))

    await handoff.autoRecoverSkipped(ctx)
    expect(resumeCalls.length).toBe(0)
  })

  it('recovers a snapshot session that was running in the PREVIOUS host life with no will', async () => {
    const mountCalls: string[] = []
    const reminderSent: string[] = []
    let published: Agent | undefined
    const { ctx } = await harness({
      agentPresets: {
        composedPreset: () => undefined,
        mount: async (_agentCtx: Context, preset?: string) => { mountCalls.push(preset ?? '(default)') },
      },
      resume: async (opts: { resumeSessionId: SessionId; setup?: (agentCtx: Context) => Promise<void> }): Promise<{ agent: Agent }> => {
        const { agent } = stubAgent(opts.resumeSessionId)
        agent.followup = (message) => {
          reminderSent.push(message.content.map(b => b.type === 'text' ? b.text : '').join(''))
        }
        published = agent
        await opts.setup?.(agent.ctx)
        return { agent }
      },
    })
    // The durable snapshot names a session that was running in a PREVIOUS host
    // life (startedAt older than this host's epoch) but left no will: a
    // restart that never ran the broadcast. auto-recover must materialize a
    // fallback will for it and resume it.
    const snapshotId = 'snapshot-recover'
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, 'running-sessions.json'), JSON.stringify({
      [snapshotId]: { provider: 'deepseek-official', model: 'deepseek-v4-flash', startedAt: Date.now() - 24 * 3600_000 },
    }))

    await handoff.autoRecoverSkipped(ctx)

    expect(mountCalls).toEqual(['(default)'])
    expect(published).toBeDefined()
    expect(reminderSent.length).toBe(1)
    expect(reminderSent[0]).toContain('<handoff_reminder>')
    // The snapshot was consumed (deleted) after materialization.
    expect(fs.existsSync(path.join(handoffDir, 'running-sessions.json'))).toBe(false)
  })
})

describe('teardown fallback wills', () => {
  it('writes a generic pending will for every agent that was RUNNING at dispose', async () => {
    const { ctx, fiber } = await harness()
    const { agent: working } = stubAgent('fallback-working')
    ctx.agents.register(working)
    // The live "running" fact is maintained from agent/status, NOT queried from
    // the registry at teardown: emit the running transition, then dispose.
    ctx.emit('agent/status', { agent: working, status: 'running' })
    const { agent: idle } = stubAgent('fallback-idle')
    ctx.agents.register(idle)
    ctx.emit('agent/status', { agent: idle, status: 'idle' })

    await fiber.dispose()

    const file = path.join(handoffDir, `${working.id}.json`)
    expect(fs.existsSync(file)).toBe(true)
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(record.pending).toBe(true)
    expect(record.fallback).toBe(true)
    expect(String(record.objective)).toContain('Host restarted')
    // Idle agents are not protected: nothing to interrupt.
    expect(fs.existsSync(path.join(handoffDir, `${idle.id}.json`))).toBe(false)
  })

  it('does not overwrite an existing pending will at teardown', async () => {
    const { ctx, fiber } = await harness()
    const { agent: target } = stubAgent('fallback-keep')
    ctx.agents.register(target)
    ctx.emit('agent/status', { agent: target, status: 'running' })
    // A real will already exists.
    fs.mkdirSync(handoffDir, { recursive: true })
    fs.writeFileSync(path.join(handoffDir, `${target.id}.json`), JSON.stringify({
      sessionId: target.id, objective: 'real will', pending: true,
      wroteAt: new Date().toISOString(), requestId: 'real-request',
    }))

    await fiber.dispose()

    const record = JSON.parse(fs.readFileSync(path.join(handoffDir, `${target.id}.json`), 'utf8')) as Record<string, unknown>
    expect(record.objective).toBe('real will')
    expect(record.fallback).toBeUndefined()
  })

  it('keeps the durable snapshot after the agent goes idle (shutdown cancel must not erase it)', async () => {
    const { ctx, fiber } = await harness()
    const { agent: working } = stubAgent('snapshot-kept')
    ctx.agents.register(working)
    ctx.emit('agent/status', { agent: working, status: 'running' })
    // The shutdown cancel fires idle; the DURABLE snapshot must survive it so
    // teardown still sees the session as running-when-this-host-died.
    ctx.emit('agent/status', { agent: working, status: 'idle' })

    await fiber.dispose()

    const file = path.join(handoffDir, `${working.id}.json`)
    expect(fs.existsSync(file)).toBe(true)
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(record.fallback).toBe(true)
  })
})

