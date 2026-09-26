/** 应答侧限速：每个对端 30s 最多接一条 offer，超额回 decline，不再静默丢掉。 */

export const DC_ANSWER_MIN_INTERVAL_MS = 30_000;

export class AnswerRateLimit {
  private readonly lastAccept = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  retryAfterMs(peer: string, now = this.now()): number {
    const last = this.lastAccept.get(peer);
    if (last == null) return 0;
    return Math.max(0, DC_ANSWER_MIN_INTERVAL_MS - (now - last));
  }

  blocked(peer: string, now = this.now()): boolean {
    return this.retryAfterMs(peer, now) > 0;
  }

  noteAccepted(peer: string, now = this.now()): void {
    this.lastAccept.set(peer, now);
  }

  reset(peer?: string): void {
    if (peer) this.lastAccept.delete(peer);
    else this.lastAccept.clear();
  }
}
