import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Per-API-key sliding window rate limiter.
 * The inherited IP-keyed throttler collapses all MCP calls into one 127.0.0.1 bucket,
 * so MCP needs its own per-key limiter.
 * In-memory per-process; move to Redis for multi-instance deployments.
 */
export class KeyRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max = 60,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(key: string): void {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter(ts => t - ts < this.windowMs);
    if (recent.length === 0) {
      // All prior hits have expired — prune the bucket rather than accumulating stale entries.
      this.hits.delete(key);
    }
    if (recent.length >= this.max) {
      throw new HttpException('MCP rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(t);
    this.hits.set(key, recent);
  }
}
