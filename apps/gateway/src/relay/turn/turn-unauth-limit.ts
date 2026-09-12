import {
  UNAUTH_GLOBAL_BURST,
  UNAUTH_GLOBAL_RATE,
  UNAUTH_IDLE_MS,
  UNAUTH_MAX_IPS,
  UNAUTH_PER_IP_BURST,
  UNAUTH_PER_IP_RATE,
} from './turn-limits';

type IpBucket = { tokens: number; tokenAt: number; lastAt: number };

export class UnauthResponseLimiter {
  private readonly ips = new Map<string, IpBucket>();
  private globalTokens: number;
  private globalAt: number;

  constructor(private readonly now: () => number) {
    this.globalTokens = UNAUTH_GLOBAL_BURST;
    this.globalAt = now();
  }

  get size(): number {
    return this.ips.size;
  }

  allow(ip: string): boolean {
    const now = this.now();
    this.sweep(now);
    const row = this.touch(ip, now);
    this.globalTokens = refill(
      this.globalTokens,
      this.globalAt,
      now,
      UNAUTH_GLOBAL_RATE,
      UNAUTH_GLOBAL_BURST
    );
    this.globalAt = now;
    row.tokens = refill(row.tokens, row.tokenAt, now, UNAUTH_PER_IP_RATE, UNAUTH_PER_IP_BURST);
    row.tokenAt = now;
    if (this.globalTokens < 1 || row.tokens < 1) return false;
    this.globalTokens -= 1;
    row.tokens -= 1;
    return true;
  }

  private sweep(now: number): void {
    for (const [ip, row] of this.ips) {
      if (now - row.lastAt >= UNAUTH_IDLE_MS) this.ips.delete(ip);
    }
  }

  private touch(ip: string, now: number): IpBucket {
    const existing = this.ips.get(ip);
    if (existing) {
      existing.lastAt = now;
      this.ips.delete(ip);
      this.ips.set(ip, existing);
      return existing;
    }
    const created: IpBucket = {
      tokens: UNAUTH_PER_IP_BURST,
      tokenAt: now,
      lastAt: now,
    };
    this.ips.set(ip, created);
    this.evictOverflow();
    return created;
  }

  private evictOverflow(): void {
    while (this.ips.size > UNAUTH_MAX_IPS) {
      const oldest = this.ips.keys().next().value;
      if (oldest === undefined) break;
      this.ips.delete(oldest);
    }
  }
}

function refill(tokens: number, from: number, now: number, rate: number, burst: number): number {
  const elapsed = Math.max(0, now - from) / 1000;
  return Math.min(burst, tokens + elapsed * rate);
}
