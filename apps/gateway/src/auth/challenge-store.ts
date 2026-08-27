import type { ChallengeKind } from './types';

export type { ChallengeKind };

export interface ChallengeCreateInput {
  uid: string;
  entryNodeId: string;
  kind: ChallengeKind;
  ttlMs: number;
  payload?: unknown;
}

export interface ChallengeEntry {
  challengeId: string;
  nonce: Uint8Array;
  uid: string;
  entryNodeId: string;
  kind: ChallengeKind;
  expiresAt: number;
  payload?: unknown;
}

export class ChallengeStore {
  private readonly entries = new Map<string, ChallengeEntry>();
  private readonly nowFn: () => number;

  constructor(options?: { now?: () => number }) {
    this.nowFn = options?.now ?? Date.now;
  }

  create(input: ChallengeCreateInput): { challengeId: string; nonce: Uint8Array } {
    this.sweepExpired();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const challengeId = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
      'base64url'
    );
    const entry: ChallengeEntry = {
      challengeId,
      nonce: Uint8Array.from(nonce),
      uid: input.uid,
      entryNodeId: input.entryNodeId,
      kind: input.kind,
      expiresAt: this.nowFn() + input.ttlMs,
      payload: input.payload,
    };
    this.entries.set(challengeId, entry);
    return { challengeId, nonce: Uint8Array.from(nonce) };
  }

  consume(challengeId: string): ChallengeEntry | null {
    this.sweepExpired();
    const entry = this.entries.get(challengeId);
    if (!entry) {
      return null;
    }
    this.entries.delete(challengeId);
    return cloneEntry(entry);
  }

  sweepExpired(now = this.nowFn()): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

function cloneEntry(entry: ChallengeEntry): ChallengeEntry {
  return {
    ...entry,
    nonce: Uint8Array.from(entry.nonce),
  };
}
