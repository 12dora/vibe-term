import type { WatchRuleSampleDto } from '@tmex/shared';

export const SAMPLE_RING_LIMIT = 120;

export class WatchSampleStore {
  private readonly samples = new Map<string, WatchRuleSampleDto[]>();

  constructor(private readonly limit = SAMPLE_RING_LIMIT) {}

  push(ruleId: string, at: Date, value: string | null, hit: boolean): void {
    let ring = this.samples.get(ruleId);
    if (!ring) {
      ring = [];
      this.samples.set(ruleId, ring);
    }
    ring.push({ at: at.toISOString(), value, hit });
    if (ring.length > this.limit) {
      ring.splice(0, ring.length - this.limit);
    }
  }

  get(ruleId: string): WatchRuleSampleDto[] {
    return [...(this.samples.get(ruleId) ?? [])];
  }

  delete(ruleId: string): void {
    this.samples.delete(ruleId);
  }

  clear(): void {
    this.samples.clear();
  }
}
