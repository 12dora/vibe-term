/** 应答侧（对端发起）连续超时后的 offer 忽略：不抬本端 offerer 熔断，只挡住再应答。 */

export const ANSWERER_TIMEOUT_LIMIT = 3;
/** 30 s → 2 min → 10 min。 */
export const ANSWERER_COOLDOWN_MS = [30_000, 120_000, 600_000] as const;

export type AnswererBackoffTrip = {
  opened: boolean;
  until?: number;
  cooldownMs?: number;
  consecutive: number;
};

type Rec = {
  consecutive: number;
  level: number;
  until: number;
};

export class AnswererOfferBackoff {
  private readonly recs = new Map<string, Rec>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  shouldAccept(peer: string, now = this.now()): boolean {
    const rec = this.recs.get(peer);
    return !rec || rec.until <= now;
  }

  noteTimeout(peer: string, now = this.now()): AnswererBackoffTrip {
    const rec = this.recs.get(peer) ?? { consecutive: 0, level: 0, until: 0 };
    if (rec.until > now) {
      return { opened: false, until: rec.until, consecutive: rec.consecutive };
    }
    rec.consecutive += 1;
    if (rec.consecutive < ANSWERER_TIMEOUT_LIMIT) {
      this.recs.set(peer, rec);
      return { opened: false, consecutive: rec.consecutive };
    }
    const idx = Math.min(rec.level, ANSWERER_COOLDOWN_MS.length - 1);
    const cooldownMs = ANSWERER_COOLDOWN_MS[idx];
    rec.until = now + cooldownMs;
    rec.consecutive = 0;
    rec.level = Math.min(rec.level + 1, ANSWERER_COOLDOWN_MS.length - 1);
    this.recs.set(peer, rec);
    return { opened: true, until: rec.until, cooldownMs, consecutive: ANSWERER_TIMEOUT_LIMIT };
  }

  noteSuccess(peer: string): void {
    this.recs.delete(peer);
  }

  reset(peer?: string): void {
    if (peer) this.recs.delete(peer);
    else this.recs.clear();
  }
}
