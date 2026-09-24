import type { DataChannelLike } from './native';

/**
 * DataChannelLink 这一代传输是否已经收到过 liveness pong。
 * generation 用来丢掉「上一条 DC 的迟到 pong」对下一条的误证明。
 */
type ProofRow = {
  generation: number;
  proven: boolean;
  listeners: Set<() => void>;
};

const rows = new Map<string, ProofRow>();
const ownedChannels = new WeakSet<DataChannelLike>();

export function ownDataChannelLink(channel: DataChannelLike): void {
  ownedChannels.add(channel);
}

export function dataChannelLinkOwns(channel: DataChannelLike): boolean {
  return ownedChannels.has(channel);
}

export function beginDcLinkProof(peer: string): number {
  const generation = (rows.get(peer)?.generation ?? 0) + 1;
  rows.set(peer, { generation, proven: false, listeners: new Set() });
  return generation;
}

export function currentDcProofGeneration(peer: string): number | undefined {
  return rows.get(peer)?.generation;
}

export function dcLinkProven(peer: string, generation: number | undefined): boolean {
  if (generation === undefined) return false;
  const row = rows.get(peer);
  return row?.proven === true && row.generation === generation;
}

/** 只标记 beginDcLinkProof 开启的那一代。没有对应一代时忽略。 */
export function markDcLinkProof(peer: string, generation: number): void {
  const row = rows.get(peer);
  if (!row || row.proven || row.generation !== generation) return;
  row.proven = true;
  for (const fn of [...row.listeners]) fn();
}

export function subscribeDcLinkProof(
  peer: string,
  generation: number | undefined,
  fn: () => void
): () => void {
  const row = rows.get(peer);
  if (!row || generation === undefined || row.generation !== generation) return () => {};
  row.listeners.add(fn);
  if (row.proven) fn();
  return () => {
    row.listeners.delete(fn);
  };
}

export function resetDcLinkProofForTests(): void {
  rows.clear();
}
