# 32 - Session Hibernation (Idle RAM Saving)

## 32.1 Why

Each active WhatsApp session runs its own headless Chromium instance (via
`whatsapp-web.js` + Puppeteer). Memory usage grows roughly linearly with the
number of active sessions (~1 Chromium per session), so a server hosting many
sessions can exhaust its RAM even when most sessions are idle.

**Hibernation** unloads idle sessions to free RAM and reloads them on demand.
Because `whatsapp-web.js` uses `LocalAuth` (the WhatsApp auth data is persisted
on disk under `SESSION_DATA_PATH`), resuming a hibernated session **does not
require scanning the QR code again** — it reconnects in ~5–15 s.

## 32.2 How it works

### Lifecycle

```
READY  ──(no outgoing message for idleTimeout)──►  HIBERNATED
HIBERNATED  ──(POST /wake  OR  transparent wake on send)──►  INITIALIZING ─► READY
```

- A new session status `HIBERNATED` is introduced (distinct from `DISCONNECTED`,
  which triggers auto-reconnect, and `FAILED`).
- A periodic **idle checker** (`setInterval`, no Redis dependency) inspects all
  loaded engines. A session is hibernated when **all** of the following hold:
  - status is `READY`
  - `keepAlive` is not set on the session config
  - time since the last **outgoing** message (`lastSentAt`, falling back to
    `connectedAt`) exceeds the idle window.
- Hibernation destroys the engine (`engine.destroy()`, frees the Chromium
  process) and sets status to `HIBERNATED`. Auth data stays on disk.

### Activity definition

Only **outgoing** messages count as activity (`lastSentAt`). Incoming messages
do **not** keep a session alive — a session that only receives spam will still
hibernate. `lastSentAt` is updated by `SessionHibernationService.markActivity()`, called
from the message-send paths (`MessageService`, `BulkMessageService`).

### Resume flows

1. **Client-driven (recommended):** the client checks status and wakes the
   session before sending.
   ```
   GET  /sessions/{sessionId}            -> status: "hibernated"
   POST /sessions/{sessionId}/wake       -> status: "initializing"
   (poll GET /sessions/{sessionId}  OR  listen to the session.status WebSocket event)
   ...                           -> status: "ready"
   POST /sessions/{sessionId}/messages/send-text
   ```
2. **Server-side safety net:** if a send arrives while the session is
   `HIBERNATED`, the server transparently wakes it
   (`SessionHibernationService.ensureEngineReady()`), waits for `READY` (up to
   `SESSION_WAKE_TIMEOUT_MS`), then sends. Only `HIBERNATED` sessions are
   auto-resumed — sessions that were never authenticated still error so the
   client knows a QR scan / explicit start is required.

### Reconnect guard

Hibernating goes through the lifecycle's own retirement path, so it inherits the
stop mark (`markStopping()` / `stoppingSessions` in
`session-engine-lifecycle.service.ts`): the armed reconnect is cancelled, and the
engine's own `disconnected` transition is neither persisted nor broadcast while
the mark is set (`session-engine-event-wiring.ts`), so the session reports one
transition — straight to `HIBERNATED` — instead of flashing `disconnected` first.

## 32.3 Configuration

| Env var                          | Default   | Description                                                        |
| -------------------------------- | --------- | ------------------------------------------------------------------ |
| `SESSION_HIBERNATION_ENABLED`    | `false`   | Master switch. When `false`, the idle checker never runs.          |
| `SESSION_IDLE_TIMEOUT_MS`        | `5400000` | Idle window (no outgoing message) before hibernation. Default 90m. |
| `SESSION_IDLE_CHECK_INTERVAL_MS` | `300000`  | How often the idle checker runs. Default 5m.                       |
| `SESSION_WAKE_TIMEOUT_MS`        | `45000`   | Max wait for a session to become READY when waking transparently.  |

### Per-session overrides

Set via the session's `config` object (e.g. on `POST /sessions`):

```jsonc
{
  "name": "my-bot",
  "config": {
    "keepAlive": true, // never hibernate this session
    "idleTimeoutMs": 3600000, // override the global idle window (1h here)
  },
}
```

## 32.4 API

| Method | Path                         | Description                                        |
| ------ | ---------------------------- | -------------------------------------------------- |
| `POST` | `/sessions/{sessionId}/wake` | Resume a hibernated session (no QR scan required). |

The `SessionResponseDto` exposes `lastSent` (last outgoing message timestamp),
and `status` may now be `hibernated`.

## 32.5 Events & hooks

- WebSocket: the existing `session.status` event carries the `hibernated`
  status (no new event type required).
- Plugin hooks: `session:hibernated`, `session:resuming`, `session:resumed`.

## 32.6 SDK helpers

All five clients expose `wake`, which asks the gateway to reload the engine and
returns as soon as it is launching. There is no client-side wait-until-ready
helper: poll the session until it reports `ready`, or simply send — the gateway
wakes a hibernated session on the way in (§32.2).

```typescript
// JavaScript/TypeScript
await client.sessions.wake('session-1');
// or skip the wake entirely — the send resumes the session itself:
await client.messages.sendText('session-1', { chatId, text });
```

```python
# Python
client.sessions.wake("session-1")
client.messages.send_text("session-1", {"chatId": chat_id, "text": text})
```

## 32.7 Relevant code

| Concern                         | Location                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Status enum + `lastSentAt`      | `src/modules/session/entities/session.entity.ts`                                               |
| Idle checker, hibernate/wake    | `src/modules/session/session-hibernation.service.ts`                                           |
| Wake endpoint                   | `src/modules/session/session.controller.ts`                                                    |
| Transparent wake on send        | `src/modules/message/message-send.service.ts`, `message.service.ts`, `bulk-message.service.ts` |
| Config                          | `src/config/configuration.ts`, `.env.example`                                                  |
| Migration (`lastSentAt` column) | `src/database/migrations/1781050000000-AddSessionLastSentAt.ts`                                |
| Hooks                           | `src/core/hooks/hook.interfaces.ts`                                                            |
| Final-status hook into `stop()` | `src/modules/session/session-engine-controls.ts`                                               |
