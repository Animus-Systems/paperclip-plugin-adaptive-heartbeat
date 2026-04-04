# Adaptive Heartbeat — Paperclip Plugin

Event-driven agent scheduling for [Paperclip](https://github.com/paperclipai/paperclip). Replaces fixed-interval heartbeats with intelligent, workload-based invocations.

## Problem

Paperclip's default heartbeat runs every agent at a fixed interval (typically 1 hour), regardless of workload. This means:

- An agent with 16 pending issues waits the same as one with 0
- New issue assignments wait up to 1 hour for pickup
- Idle agents waste runs saying "no tasks"
- Backlogs clear slowly even when agents could work faster

## Solution

This plugin makes agent scheduling event-driven:

| Trigger | Action |
| --- | --- |
| Issue assigned to agent | Invoke agent immediately |
| Issue reassigned | Invoke new assignee immediately |
| Agent finishes run, has more work | Re-invoke after 60-120s delay |
| Agent finishes run, backlog clear | Do nothing (agent rests) |
| Periodic scan (every 2 min) | Catch any missed backlogs |

**Cost impact: Zero or negative.** Eliminates idle heartbeat waste. Only invokes agents that have actual work.

## How It Works

```
Issue Created/Assigned
  └─ Plugin receives event
      └─ Check: agent in cooldown? → skip
      └─ Check: agent paused? → skip
      └─ Check: backlog > 0? → invoke immediately
          └─ Agent runs, completes task
              └─ Plugin receives agent.run.finished
                  └─ Check remaining backlog
                      └─ backlog > 0 → schedule re-invoke (60-120s)
                      └─ backlog = 0 → done, agent rests
```

Debouncing prevents rapid-fire invocations (e.g., 5 issues assigned at once → 1 invocation, not 5).

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| Enabled | `true` | Master on/off switch |
| Cooldown | `60s` | Min seconds between invocations per agent |
| Backlog Delay | `120s` | Re-invoke delay for 1-2 pending issues |
| Heavy Backlog Delay | `60s` | Re-invoke delay for 3+ pending issues |

## Dashboard Widget

Shows:
- Active agent backlogs with queue depth
- Recent invocations with reason and timing
- Total invocation count

## Installation

```bash
npm install && npm run build
```

Install in Paperclip UI: Settings → Plugins → Install → `@animusystems/paperclip-plugin-adaptive-heartbeat`

## License

MIT
