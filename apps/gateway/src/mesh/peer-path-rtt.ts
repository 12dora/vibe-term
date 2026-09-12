export type PathRttKind = 'tcp-connect' | 'dc' | 'ws-secure';

export type PathRttSample = { kind: PathRttKind; rttMs: number; at: number };

export type PeerPathRttMemoryOptions = {
  now?: () => number;
  /** 样本保鲜期：过期样本不再参与「最佳路径」判断，默认 24 h。 */
  ttlMs?: number;
  /** 每对端每种来源最多保留的样本数，默认 16。 */
  perKindLimit?: number;
};

export const PEER_PATH_RTT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * TCP connect 样本低于真实链路（dc / ws-secure 心跳）最佳 RTT 的这个比例时，视为握手被本机
 * TUN / 代理（Surge、mihomo 等）就地终结的假样本，不进记忆；已记的也在真实样本到来时清掉。
 * 比例只能兜底：ECMP 慢路径本身就可能是快路径的 2 倍，所以主判定靠 `tcp-sampling-trust.ts`
 * 的金丝雀探测（连一个必然关闭的端口也能「握手成功」= 本机就地终结）。
 */
export const TCP_CONNECT_FLOOR_RATIO = 0.2;
const REAL_KINDS: readonly PathRttKind[] = ['dc', 'ws-secure'];
/** 对端最佳路径的滑动窗口：过期样本不再触发重掷，避免全路径一起劣化时被陈旧 best 反复误伤。 */
export const PEER_PATH_RTT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_PER_KIND_LIMIT = 16;

/**
 * 每个对端的「最佳已知路径 RTT」记忆：TCP connect 抽样、DC 会话与 ws-secure 会话的稳态 RTT
 * 都是同一对主机在不同五元组上的观测；取其中的最小值作为该对主机可达的最佳路径参考，
 * 供 DC 重掷策略判断当前链路是否落在了绕行路径上。
 */
export class PeerPathRttMemory {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly perKindLimit: number;
  private readonly samples = new Map<string, Map<PathRttKind, PathRttSample[]>>();

  constructor(opts: PeerPathRttMemoryOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? PEER_PATH_RTT_TTL_MS;
    this.perKindLimit = opts.perKindLimit ?? DEFAULT_PER_KIND_LIMIT;
  }

  /** 返回是否真的记下了（被判为本地终结的 TCP 样本返回 false）。 */
  record(peerId: string, sample: Omit<PathRttSample, 'at'> & { at?: number }): boolean {
    if (!Number.isFinite(sample.rttMs) || sample.rttMs < 0) return false;
    if (sample.kind === 'tcp-connect') {
      const realBest = this.bestMs(peerId, REAL_KINDS);
      if (realBest !== null && sample.rttMs < realBest * TCP_CONNECT_FLOOR_RATIO) return false;
    }
    const at = sample.at ?? this.now();
    let byKind = this.samples.get(peerId);
    if (!byKind) {
      byKind = new Map();
      this.samples.set(peerId, byKind);
    }
    const list = byKind.get(sample.kind) ?? [];
    list.push({ kind: sample.kind, rttMs: sample.rttMs, at });
    while (list.length > this.perKindLimit) list.shift();
    byKind.set(sample.kind, list);
    if (sample.kind !== 'tcp-connect') this.dropLocalTerminatedTcp(byKind, sample.rttMs);
    return true;
  }

  private dropLocalTerminatedTcp(byKind: Map<PathRttKind, PathRttSample[]>, realMs: number): void {
    const tcp = byKind.get('tcp-connect');
    if (!tcp) return;
    const floor = realMs * TCP_CONNECT_FLOOR_RATIO;
    const kept = tcp.filter((entry) => entry.rttMs >= floor);
    if (kept.length === 0) byKind.delete('tcp-connect');
    else byKind.set('tcp-connect', kept);
  }

  /** 未过期样本中的最小 RTT；可限定来源种类。没有样本时返回 null。 */
  bestMs(peerId: string, kinds?: readonly PathRttKind[]): number | null {
    const byKind = this.samples.get(peerId);
    if (!byKind) return null;
    const cutoff = this.now() - this.ttlMs;
    let best: number | null = null;
    for (const [kind, list] of byKind) {
      if (kinds && !kinds.includes(kind)) continue;
      for (const sample of list) {
        if (sample.at < cutoff) continue;
        if (best === null || sample.rttMs < best) best = sample.rttMs;
      }
    }
    return best;
  }

  samplesOf(peerId: string): PathRttSample[] {
    const byKind = this.samples.get(peerId);
    if (!byKind) return [];
    const cutoff = this.now() - this.ttlMs;
    const out: PathRttSample[] = [];
    for (const list of byKind.values()) {
      for (const sample of list) if (sample.at >= cutoff) out.push(sample);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  forget(peerId: string): void {
    this.samples.delete(peerId);
  }

  /** 清掉过期样本；空对端一并移除。 */
  prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [peerId, byKind] of this.samples) {
      for (const [kind, list] of byKind) {
        const kept = list.filter((sample) => sample.at >= cutoff);
        if (kept.length === 0) byKind.delete(kind);
        else byKind.set(kind, kept);
      }
      if (byKind.size === 0) this.samples.delete(peerId);
    }
  }
}
