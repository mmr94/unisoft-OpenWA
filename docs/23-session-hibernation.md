# 23 - Session Hibernation (Idle RAM Saving)

## 23.1 Why

Each active WhatsApp session runs its own headless Chromium instance (via
`whatsapp-web.js` + Puppeteer). Memory usage grows roughly linearly with the
number of active sessions (~1 Chromium per session), so a server hosting many
sessions can exhaust its RAM even when most sessions are idle.

**Hibernation** unloads idle sessions to free RAM and reloads them on demand.
Because `whatsapp-web.js` uses `LocalAuth` (the WhatsApp auth data is persisted
on disk under `SESSION_DATA_PATH`), resuming a hibernated session **does not
require scanning the QR code again** — it reconnects in ~5–15 s.

## 23.2 How it works

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
hibernate. `lastSentAt` is updated by `SessionService.markActivity()`, called
from the message-send paths (`MessageService`, `BulkMessageService`).

### Resume flows

1. **Client-driven (recommended):** the client checks status and wakes the
   session before sending.
   ```
   GET  /sessions/:id            -> status: "hibernated"
   POST /sessions/:id/wake       -> status: "initializing"
   (poll GET /sessions/:id  OR  listen to the session.status WebSocket event)
   ...                           -> status: "ready"
   POST /sessions/:id/messages/send-text
   ```
2. **Server-side safety net:** if a send arrives while the session is
   `HIBERNATED`, the server transparently wakes it
   (`SessionService.ensureEngineReady()`), waits for `READY` (up to
   `SESSION_WAKE_TIMEOUT_MS`), then sends. Only `HIBERNATED` sessions are
   auto-resumed — sessions that were never authenticated still error so the
   client knows a QR scan / explicit start is required.

### Reconnect guard

Stopping or hibernating a session adds its id to an internal `intentionalStops`
set so the engine's `disconnected` event does **not** trigger a reconnect or
overwrite the intentional status.

## 23.3 Configuration

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
    "keepAlive": true,        // never hibernate this session
    "idleTimeoutMs": 3600000  // override the global idle window (1h here)
  }
}
```

## 23.4 API

| Method | Path                  | Description                                        |
| ------ | --------------------- | -------------------------------------------------- |
| `POST` | `/sessions/:id/wake`  | Resume a hibernated session (no QR scan required). |

The `SessionResponseDto` exposes `lastSent` (last outgoing message timestamp),
and `status` may now be `hibernated`.

## 23.5 Events & hooks

- WebSocket: the existing `session.status` event carries the `hibernated`
  status (no new event type required).
- Plugin hooks: `session:hibernated`, `session:resuming`, `session:resumed`.

## 23.6 SDK helpers

Both SDKs expose a wake call and an `ensureReady` helper that wakes a hibernated
session and polls until it is `READY`:

```typescript
// JavaScript/TypeScript
await client.ensureReady('session-1');
await client.messages.sendText('session-1', { chatId, text });
```

```python
# Python
client.sessions.ensure_ready("session-1")
client.messages.send_text("session-1", {"chatId": chat_id, "text": text})
```

## 23.7 Relevant code

| Concern                          | Location                                                        |
| -------------------------------- | --------------------------------------------------------------- |
| Status enum + `lastSentAt`       | `src/modules/session/entities/session.entity.ts`                |
| Idle checker, hibernate/wake     | `src/modules/session/session.service.ts`                        |
| Wake endpoint                    | `src/modules/session/session.controller.ts`                     |
| Transparent wake on send         | `src/modules/message/message.service.ts`, `bulk-message.service.ts` |
| Config                           | `src/config/configuration.ts`, `.env.example`                   |
| Migration (`lastSentAt` column)  | `src/database/migrations/1781000000000-AddSessionLastSentAt.ts`  |
| Hooks                            | `src/core/hooks/hook.interfaces.ts`                             |
