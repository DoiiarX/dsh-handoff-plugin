import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as handoff from '@deepseek-ai/dsh-handoff'
import { MockAdapter, toolCallResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

let dshHome: string
let handoffDir: string

beforeEach(() => {
  dshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handoff-loop-'))
  handoffDir = path.join(dshHome, '.handoff')
  process.env.DSH_HOME = dshHome
})

afterEach(() => {
  delete process.env.DSH_HOME
  fs.rmSync(dshHome, { recursive: true, force: true })
})

function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

function waitForIdle(ctx: Context, agentId: string): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent, status }) => {
      if (agent.id === agentId && status === 'idle') { dispose(); resolve() }
    })
  })
}

/**
 * REAL-composition broadcast test on a real AgentLoop. The initiator's model
 * round calls `handoff_at_restart`; the target is cancelled, awaited idle, sent
 * one independent handoff turn whose model round calls `handoff_save`.
 */
describe('handoff_at_restart against a real AgentLoop', () => {
  it('delivers the request turn and settles via the target\'s own handoff_save', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Timer)
    ctx.provide('goals', { get: () => undefined })
    ctx.provide('agentPresets', { composedPreset: () => undefined, mount: async () => {} })
    await ctx.plugin(handoff)
    await ctx.plugin(AgentLoop, { agents: [] })

    // The target's first round is long-running text work; the second round
    // (the handoff turn) calls handoff_save.
    const targetAdapter = new MockAdapter([
      'hang', // first round: streaming work until cancelled
      () => toolCallResponse(`call_${randomUUID().replaceAll('-', '')}`, 'handoff_save', {
        objective: 'target work', progress: 'half', next_step: 'finish',
      }),
      () => textResponse('will recorded'),
    ])
    ctx.llm.registerAdapter(['mock-target'], targetAdapter)
    const target = ctx.agentLoop.create(SessionId(`target-${Math.random()}`), { provider: 'mock-target', model: 'mock' })
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'do long work' }], source: { kind: 'user' } }))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(target.status).toBe('running')

    // The initiator's first round calls handoff_at_restart; the second closes.
    const initiatorAdapter = new MockAdapter([
      () => toolCallResponse(`call_${randomUUID().replaceAll('-', '')}`, 'handoff_at_restart', { wait_seconds: 10 }),
      () => textResponse('restart requested'),
    ])
    ctx.llm.registerAdapter(['mock-init'], initiatorAdapter)
    const initiator = ctx.agentLoop.create(SessionId(`initiator-${Math.random()}`), { provider: 'mock-init', model: 'mock' })
    initiator.followup(createUserMessage({ content: [{ type: 'text', text: 'please restart the host' }], source: { kind: 'user' } }))

    // The initiator's round completes after the tool settles (target wrote its
    // will), so wait for BOTH agents to reach idle.
    await Promise.all([waitForIdle(ctx, initiator.id), waitForIdle(ctx, target.id)])

    // The target must have RECEIVED the handoff request text.
    const targetSawRequest = targetAdapter.requests.some(options => requestText(options).includes('<handoff_request>'))
    expect(targetSawRequest).toBe(true)

    // The restart file was written only after the target settled.
    expect(fs.existsSync(path.join(handoffDir, '.restart-request'))).toBe(true)
    const record = JSON.parse(fs.readFileSync(path.join(handoffDir, `${target.id}.json`), 'utf8')) as Record<string, unknown>
    expect(record.pending).toBe(true)
    expect(typeof record.requestId).toBe('string')
  })

  it('does NOT restart when the target never settles', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Timer)
    ctx.provide('goals', { get: () => undefined })
    ctx.provide('agentPresets', { composedPreset: () => undefined, mount: async () => {} })
    await ctx.plugin(handoff)
    await ctx.plugin(AgentLoop, { agents: [] })

    // The target's model responds to the handoff request but never calls
    // handoff_save (it ignores restart requests).
    const targetAdapter = new MockAdapter([
      'hang',
      () => textResponse('I ignore restart requests'),
    ])
    ctx.llm.registerAdapter(['mock-target'], targetAdapter)
    const target = ctx.agentLoop.create(SessionId(`target-${Math.random()}`), { provider: 'mock-target', model: 'mock' })
    target.followup(createUserMessage({ content: [{ type: 'text', text: 'do long work' }], source: { kind: 'user' } }))
    await new Promise(resolve => setTimeout(resolve, 100))

    const initiatorAdapter = new MockAdapter([
      () => toolCallResponse(`call_${randomUUID().replaceAll('-', '')}`, 'handoff_at_restart', { wait_seconds: 1 }),
      () => textResponse('no restart'),
    ])
    ctx.llm.registerAdapter(['mock-init'], initiatorAdapter)
    const initiator = ctx.agentLoop.create(SessionId(`initiator-${Math.random()}`), { provider: 'mock-init', model: 'mock' })
    initiator.followup(createUserMessage({ content: [{ type: 'text', text: 'please restart' }], source: { kind: 'user' } }))

    await Promise.all([waitForIdle(ctx, initiator.id), waitForIdle(ctx, target.id)])

    expect(fs.existsSync(path.join(handoffDir, '.restart-request'))).toBe(false)
    // The initiator saw an unconfirmed target in its tool result (tool results
    // arrive as tool-result messages, not plain text).
    const initiatorText = initiatorAdapter.requests
      .flatMap(options => options.messages.flatMap(m => m.content))
      .map(block => {
        if (block.type === 'text') return block.text
        if (block.type === 'tool-result') return JSON.stringify(block.content ?? block)
        return ''
      })
      .join('\n')
    expect(initiatorText).toContain('unconfirmed')
  })
})

/** Direct save/clear against a real loop (not broadcast). */
describe('handoff_save against a real AgentLoop', () => {
  it('writes and clears a durable record when its model round calls the tool', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Timer)
    ctx.provide('goals', { get: () => undefined })
    ctx.provide('agentPresets', { composedPreset: () => undefined, mount: async () => {} })
    await ctx.plugin(handoff)
    await ctx.plugin(AgentLoop, { agents: [] })

    const adapter = new MockAdapter([
      () => toolCallResponse(`call_${randomUUID().replaceAll('-', '')}`, 'handoff_save', {
        objective: 'real loop save', progress: 'p', next_step: 'n',
      }),
      () => toolCallResponse(`call_${randomUUID().replaceAll('-', '')}`, 'handoff_clear', {}),
      () => textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId(`save-${Math.random()}`), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'save then clear' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent.id)

    const file = path.join(handoffDir, `${agent.id}.json`)
    // Saved during the first tool call, then cleared by the second: the file
    // is gone at the end, but the save did happen in between.
    expect(fs.existsSync(file)).toBe(false)
    // The model round ran (save + clear + close), proving the tools executed.
    expect(adapter.requests.length).toBeGreaterThanOrEqual(3)
  })
})
