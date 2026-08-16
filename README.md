# @doiiarx/dsh-handoff-plugin

English | [中文](README.zh.md)

> Part of the [dsh-plugins](https://github.com/DoiiarX/dsh-plugins) collection — see that repository for the full index.

Restart handoff (遗言) — durable per-session "last will" notes, plus an automatic continue-reminder when a Host restart resumes a session. The package is a host-level function plugin: every session (any preset) gains the three tools and the restart-reminder listener.

## Tools

- `handoff_save(objective, progress?, next_step?, goal_id?, round?, note?)` writes a durable pending record for the CURRENT session, keyed by `agent.id` (= SessionId), under `<DSH_HOME>/.handoff/<sessionId>.json`. The record captures the session's own preset and provider/model route so an auto-recover mounts the same composition and restores the model. A will written while this session is a target of an in-flight restart broadcast also carries that broadcast's `requestId`, so settlement can accept exactly the records the current restart request produced.
- `handoff_clear()` removes the current session's record once its work has fully resumed or completed, so a later unrelated restart does not re-remind the finished task. During an in-flight broadcast it also settles the broadcast for this agent ("nothing in progress — no will needed").
- `handoff_at_restart(wait_seconds?)` broadcasts a "Restart is imminent, leave your handoff" request to every interruptible live agent (running, pending inbox work, or an active goal), then writes an ATTESTED restart request that the supervisor honours. The initiator is never a target. Each agent writes its own handoff content; this tool does not fabricate it.

## Event-driven broadcast

The restart broadcast is event-driven end to end, never polled:

1. Every target is cancelled (`keepInbox` preserves queued input).
2. The broadcast awaits each target's true quiescence via `Agent.whenIdle()` before sending anything, closing the cancel/send race: the request lands on an agent that has actually reached idle, never on one still converging from a cancelled activity.
3. Each target receives ONE independent handoff turn (an ordinary follow-up turn whose sole message is the request).
4. The target's model round calls `handoff_save` / `handoff_clear`, which emit the `handoff/settled` event with the broadcast `requestId`.
5. The broadcast listens for that event and resolves the moment every target has settled — no polling loop re-reads files or ticks a timer to discover progress.
6. The supervisor restart file (`<DSH_HOME>/.handoff/.restart-request`) is written ONLY when every target has settled, and it is written as an ATTESTED JSON record (`{ attested: true, requestId, requestedAt, confirmed, unconfirmed }`). If the wait budget elapses with unconfirmed targets, the tool reports them and does NOT restart, so a restart never cuts a working agent without a chance to leave its will.

Only records settled FOR the current broadcast (matching its `requestId`) count as confirmation. A stale record left by an earlier restart can never be misread as "done" — the old-record misjudgment that previously accepted any pre-existing file as evidence.

## Attested restart (unified entry)

`handoff_at_restart` is the ONLY legitimate way to restart the Host; its model-facing description, the broadcast request, and the recovery reminder all say so explicitly. The supervisor only honours a restart trigger that is an attested JSON record written by this broadcast — carrying the broadcast `requestId` AND the initiator session id. A bare `touch .restart-request` — an agent or script restarting the Host behind the broadcast's back — is IGNORED and deleted, so a non-broadcast restart cannot cut a live session without its will. Normal restarts (supervisor SIGTERM, user button, scheduled task) that do not run the broadcast are therefore treated as unattested and refused; the teardown safety net below still protects their sessions if the Host is stopped some other way.

## Restart origin in reminders

A recovered session's `<handoff_reminder>` names WHO restarted the Host so it is never confused about why it was cut: a deliberate broadcast records its initiator session id into every will, and the reminder says "This restart was initiated by session X via the handoff broadcast." An unattested restart (agent behind the broadcast's back, user button, supervisor SIGTERM) has no initiator, and the reminder flags it as UNEXPECTED and points back at `handoff_at_restart` as the only legitimate path.

## Teardown safety net

No matter how the Host is stopped — graceful SIGTERM, a user-triggered restart, or an agent that restarts behind the broadcast's back — the plugin's teardown hook writes a generic pending will for every agent that was RUNNING and has none (`fallback: true`, "Host restarted while this session was running"). "Running" is a LIVE fact maintained in real time from `agent/status` events (a session is added when it starts running and removed when it goes idle), never a post-hoc registry query at teardown — by then every agent would already have been cancelled to idle. This closes the gap where a restart never ran `handoff_at_restart`: those sessions are still recovered on the next boot instead of silently going dark. An existing pending will is never overwritten; idle sessions (no active driver to lose) are not protected.

## Auto-recover

After the Host starts, the plugin scans `<DSH_HOME>/.handoff/` and resumes any session that owns a pending record written by a PREVIOUS host life, restoring its recorded preset and provider/model route. The reminder is NOT injected immediately: the recovered driver is first awaited to quiescence (`Agent.whenIdle()`, bounded) plus a short silence window, so a tool round that was still appending to the durable log when the previous Host died drains before the reminder opens a fresh turn — otherwise the two streams race for the next sequence number and corrupt the log (observed seq-gap damage). Only then is the reminder delivered via `Agent.followup()` (the same wake the goal-round driver uses) and the pending flag flipped, so a later unrelated restart does not re-remind the same task. Wills written during THIS host's life stay pending untouched: they are destined for the NEXT restart's auto-recover. While a broadcast window is open, the idle→deliver path is suppressed entirely, so an agent that writes its will on request is not consumed before the restart it was written for.

## Model Experience

### Handoff tools

#### What the model sees

The generated `handoff_save`, `handoff_clear`, and `handoff_at_restart` tool schemas render whenever this plugin's tool registrations are in scope; no fixed prompt section is registered. Successful results are compact JSON: `{ written, file }`, `{ cleared }`, and `{ broadcast, waitSeconds, requestFile, restarted, confirmed, unconfirmed }`.

#### Token effect

The tool schemas add a small fixed cost per request in scopes where this plugin's tool registrations are visible; each call's result is ordinary tool history.

#### KV Cache effect

Schema-prefix stable while the tool definitions are unchanged; calls and results append after the reusable request prefix.

## Known Limitations and Deferred Work

- **Settlement requires the target's cooperation** — the broadcast waits for the target's own `handoff_save` / `handoff_clear` call within the budget; a target whose model round never settles the will blocks the restart (by design, reported as unconfirmed) until the caller retries or forces a restart elsewhere.
- **No forced-restart escape hatch in this package** — a caller that must restart despite unconfirmed agents must write the `.restart-request` file itself or extend `wait_seconds`; the tool never silently restarts over an unsettled target.
- **Auto-recover resumes, it does not fork** — a pending will is delivered to the same session id; there is no "recover into a fresh session" mode.
- **One broadcast at a time** — a second `handoff_at_restart` while one is in flight returns `restarted: false` with the targets as unconfirmed rather than queueing.
