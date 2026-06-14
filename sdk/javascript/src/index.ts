/**
 * OpenWA JavaScript/TypeScript SDK
 *
 * Official client library for the OpenWA WhatsApp API Gateway.
 *
 * @example
 * ```typescript
 * import { OpenWAClient } from '@openwa/sdk';
 *
 * const client = new OpenWAClient({
 *   baseUrl: 'http://localhost:2785',
 *   apiKey: 'your-api-key',
 * });
 *
 * // Send a text message
 * const result = await client.messages.sendText('session-1', {
 *   chatId: '628123456789@c.us',
 *   text: 'Hello from OpenWA SDK!',
 * });
 * ```
 *
 * @packageDocumentation
 */

// ── Client Configuration ──────────────────────────────────────────

export interface OpenWAClientConfig {
  /** Base URL of the OpenWA API (e.g., 'http://localhost:2785') */
  baseUrl: string;

  /** API key for authentication */
  apiKey: string;

  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

// ── Response Types ────────────────────────────────────────────────

export interface MessageResponse {
  messageId: string;
  timestamp: number;
}

export interface Session {
  id: string;
  name: string;
  /** e.g. 'ready' | 'hibernated' | 'disconnected' | 'initializing' | ... */
  status: string;
  phone: string | null;
  pushName: string | null;
  connectedAt?: string | null;
  lastActive?: string | null;
  /** Timestamp of the last outgoing message (used for idle hibernation). */
  lastSent?: string | null;
}

// ── Client Class ──────────────────────────────────────────────────

export class OpenWAClient {
  private readonly config: Required<OpenWAClientConfig>;

  constructor(config: OpenWAClientConfig) {
    this.config = {
      timeout: 30000,
      ...config,
    };
  }

  // Placeholder — will be auto-generated from OpenAPI spec
  get sessions() {
    return {
      list: () => this.request<Session[]>('GET', '/api/sessions'),
      get: (id: string) => this.request<Session>('GET', `/api/sessions/${id}`),
      create: (data: { name: string }) => this.request<Session>('POST', '/api/sessions', data),
      start: (id: string) => this.request<Session>('POST', `/api/sessions/${id}/start`),
      stop: (id: string) => this.request<Session>('POST', `/api/sessions/${id}/stop`),
      /** Resume a session that was hibernated due to inactivity (no QR scan needed). */
      wake: (id: string) => this.request<Session>('POST', `/api/sessions/${id}/wake`),
      delete: (id: string) => this.request<void>('DELETE', `/api/sessions/${id}`),
    };
  }

  /**
   * Ensure a session is READY before sending, resuming it if it was hibernated.
   *
   * Recommended before sending to a session that may have been hibernated for
   * inactivity. Polls until the session reaches READY or the timeout elapses.
   *
   * @example
   * ```typescript
   * await client.ensureReady('session-1');
   * await client.messages.sendText('session-1', { chatId, text });
   * ```
   */
  async ensureReady(id: string, options: { timeoutMs?: number; pollIntervalMs?: number } = {}): Promise<Session> {
    const timeoutMs = options.timeoutMs ?? 60000;
    const pollIntervalMs = options.pollIntervalMs ?? 1000;

    let session = await this.sessions.get(id);
    if (session.status === 'ready') {
      return session;
    }

    // Wake hibernated/stopped sessions.
    if (session.status === 'hibernated' || session.status === 'disconnected') {
      await this.sessions.wake(id);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      session = await this.sessions.get(id);
      if (session.status === 'ready') {
        return session;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Session '${id}' did not become ready within ${timeoutMs}ms (status: ${session.status})`);
  }

  get messages() {
    return {
      sendText: (sessionId: string, data: { chatId: string; text: string }) =>
        this.request<MessageResponse>('POST', `/api/sessions/${sessionId}/messages/text`, data),
    };
  }

  // ── Internal HTTP client ──────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.config.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.config.timeout),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`OpenWA API Error (${response.status}): ${(error as { message: string }).message}`);
    }

    // Handle empty responses (204 No Content)
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }
}

export default OpenWAClient;
