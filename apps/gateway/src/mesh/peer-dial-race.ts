import type { WebSocketTransportInput } from '@tmex/shared/link';
import type { UserStore } from '../auth/user-store';
import { classifyRemoteAddress, hostFromWsUrl } from './address-class';
import type { PeerEndpointBackoff } from './peer-endpoint-backoff';
import {
  type DirectDialLimiter,
  type WsSecureRaceResult,
  classifyWsDialFailure,
  dialWsSecureCandidate,
  raceWsSecureEndpoints,
} from './peer-ws-race';
import type { MeshIdentity } from './types';

/**
 * 用户路径拨号竞速：DC 的 15 s 预算只属于后台升级扫描，前台 `getLink()` 最多等一个短预算
 * （`FOREGROUND_DC_BUDGET_MS`）就并行开 ws-secure，整段直连再压一个总截止时间，超时即让位给中继。
 */
export const FOREGROUND_DC_BUDGET_MS = 2_500;
export const FOREGROUND_DIRECT_DEADLINE_MS = 4_000;

export type DialRaceLegKind = 'dc' | 'ws';

export type DialRaceLeg<T> = (signal: AbortSignal) => Promise<T | null>;

export type DirectDialRaceOptions<T> = {
  dc: DialRaceLeg<T>;
  ws: DialRaceLeg<T>;
  /** 已知 DC 近期失败：不再等预算，两条腿同时起跑。 */
  wsFirst: boolean;
  budgetMs: number;
  deadlineMs: number;
  signal: AbortSignal;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 输的一方晚到的会话：不是赢家也不是当前活链路就关掉，别留悬空 RTC 会话。 */
  discard: (kind: DialRaceLegKind, session: T, winner: T | null) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
};

export type DirectDialRaceOutcome<T> = {
  winner: DialRaceLegKind | null;
  session: T | null;
  /** 命中总截止时间时仍在跑的直连腿：调用方可以先去中继，中继也不通再回头等它。 */
  pending: Promise<T | null> | null;
};

type Settled<T> = { kind: DialRaceLegKind; session: T | null };

const BUDGET = Symbol('dial-race-budget');
const DEADLINE = Symbol('dial-race-deadline');

type RaceLegs<T> = {
  aborts: Map<DialRaceLegKind, AbortController>;
  inflight: Map<DialRaceLegKind, Promise<Settled<T>>>;
};

/** 收尾：赢家定了就砍掉另一条腿（晚到的会话交给 discard）；超时则把还在跑的腿交回调用方。 */
function settleDialRace<T>(
  legs: RaceLegs<T>,
  winner: Settled<T> | null,
  timedOut: boolean,
  opts: Pick<DirectDialRaceOptions<T>, 'discard' | 'log'>
): DirectDialRaceOutcome<T> {
  const leftovers = [...legs.inflight.values()];
  const adopted = winner?.session ?? null;
  if (!timedOut) {
    for (const [kind, pending] of legs.inflight) {
      legs.aborts.get(kind)?.abort(new DOMException('dial-race-lost', 'AbortError'));
      void pending.then((late) => {
        if (late.session) opts.discard(kind, late.session, adopted);
      });
    }
  }
  legs.inflight.clear();
  if (winner) opts.log?.('dial race won', { transport: winner.kind });
  return {
    winner: winner?.kind ?? null,
    session: adopted,
    pending:
      timedOut && leftovers.length > 0
        ? Promise.all(leftovers).then((all) => all.find((row) => row.session)?.session ?? null)
        : null,
  };
}

export async function runDirectDialRace<T>(
  opts: DirectDialRaceOptions<T>
): Promise<DirectDialRaceOutcome<T>> {
  const legs: RaceLegs<T> = { aborts: new Map(), inflight: new Map() };
  const timers: AbortController[] = [];
  let winner: Settled<T> | null = null;
  let timedOut = false;

  const launch = (kind: DialRaceLegKind, run: DialRaceLeg<T>): void => {
    const ctrl = new AbortController();
    const relayAbort = () => ctrl.abort(opts.signal.reason ?? new Error('stopped'));
    if (opts.signal.aborted) relayAbort();
    else opts.signal.addEventListener('abort', relayAbort, { once: true });
    legs.aborts.set(kind, ctrl);
    legs.inflight.set(
      kind,
      run(ctrl.signal)
        .then(
          (session) => ({ kind, session }),
          () => ({ kind, session: null as T | null })
        )
        .finally(() => opts.signal.removeEventListener('abort', relayAbort))
    );
  };

  const timer = <M>(ms: number, mark: M): Promise<M> => {
    const ctrl = new AbortController();
    timers.push(ctrl);
    return opts.sleep(ms, ctrl.signal).then(
      () => mark,
      () => mark
    );
  };

  const startedAt = opts.now();
  try {
    launch('dc', opts.dc);
    if (opts.wsFirst) launch('ws', opts.ws);
    let budget = legs.inflight.has('ws') ? null : timer(opts.budgetMs, BUDGET);
    let deadline: Promise<typeof DEADLINE> | null = timer(opts.deadlineMs, DEADLINE);
    while (legs.inflight.size > 0) {
      const racers: Array<Promise<Settled<T> | typeof BUDGET | typeof DEADLINE>> = [
        ...legs.inflight.values(),
      ];
      if (budget) racers.push(budget);
      if (deadline) racers.push(deadline);
      const first = await Promise.race(racers);
      if (first === DEADLINE) {
        // 时钟没真的走过 deadline（测试用的零延时 scheduler）：不认这次超时，让两条腿跑完。
        deadline = null;
        if (opts.now() - startedAt < opts.deadlineMs) continue;
        opts.log?.('dial race deadline', { deadline_ms: opts.deadlineMs });
        timedOut = true;
        break;
      }
      if (first === BUDGET) {
        budget = null;
        opts.log?.('dial race ws start', { after_ms: opts.budgetMs, cause: 'dc_budget' });
        launch('ws', opts.ws);
        continue;
      }
      legs.inflight.delete(first.kind);
      if (first.session) {
        winner = first;
        break;
      }
      if (budget) {
        budget = null;
        opts.log?.('dial race ws start', { cause: 'dc_settled' });
        launch('ws', opts.ws);
      }
    }
    return settleDialRace(legs, winner, timedOut, opts);
  } finally {
    for (const ctrl of timers) ctrl.abort();
  }
}

/**
 * 竞速被取消时 connectToPeer 还在跑：晚到的 pc 没人认领，必须自己关掉；
 * 晚到的失败也要照记进熔断器，否则「取消」会把 DC 一直坏着这件事从账上抹掉。
 */
export function settleAbandonedDcDial(
  connectP: Promise<{ pc: { close(): void } }> | null,
  noteFailure: (reason: string) => void
): void {
  if (!connectP) return;
  void connectP.then(
    (late) => {
      try {
        late.pc.close();
      } catch {}
    },
    (err) => noteFailure(err instanceof Error ? err.message : String(err))
  );
}

/** DC 拨号是被取消的（竞速输了 / 上层停机），不是真失败：不能记进熔断器。 */
export function dcDialAborted(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  return /abort/i.test(err instanceof Error ? err.message : String(err));
}

export type WsSecureDialPorts = {
  nodeId: string;
  gen: number;
  urls: string[];
  signal: AbortSignal;
  staggerMs: number;
  connectTimeoutMs: number;
  lanTimeoutMs: number;
  identity: MeshIdentity;
  userStore: UserStore;
  limiter: DirectDialLimiter;
  backoff: PeerEndpointBackoff;
  wsFactory: (url: string) => WebSocketTransportInput | Promise<WebSocketTransportInput>;
  stale: (gen: number) => boolean;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** ws-secure 多地址竞速 + 端点退避记账：从 PeerManager 抽出的内聚块，逻辑与原实现一致。 */
export function raceWsSecureDial(ports: WsSecureDialPorts): Promise<WsSecureRaceResult> {
  const failedAddrs = new Set<string>();
  return raceWsSecureEndpoints({
    urls: ports.urls,
    gen: ports.gen,
    signal: ports.signal,
    stale: ports.stale,
    sleep: ports.sleep,
    staggerMs: ports.staggerMs,
    dial: async (url, combined) => {
      try {
        const candidate = await dialWsSecureCandidate({
          url,
          expectedId: ports.nodeId,
          gen: ports.gen,
          signal: combined,
          stale: ports.stale,
          connectTimeoutMs: ports.connectTimeoutMs,
          totalTimeoutMs:
            classifyRemoteAddress(hostFromWsUrl(url)) === 'lan' ? ports.lanTimeoutMs : undefined,
          factory: ports.wsFactory,
          identity: ports.identity,
          userStore: ports.userStore,
          limiter: ports.limiter,
        });
        if (candidate) ports.backoff.noteSuccess(ports.nodeId, url);
        return candidate;
      } catch (err) {
        const classified = classifyWsDialFailure(url, err);
        ports.backoff.noteFailureOnce(failedAddrs, ports.nodeId, url, classified.kind);
        throw classified;
      }
    },
  });
}

export type ForegroundDialPorts<T> = {
  dc: DialRaceLeg<T>;
  ws: DialRaceLeg<T>;
  wsFirst: boolean;
  signal: AbortSignal;
  scheduler: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
  live: () => T | null;
  close: (session: T, reason: string) => void;
  log: (event: string, fields: Record<string, unknown>) => void;
};

/** 用户路径的默认预算/截止时间；输掉的一方晚到就地关掉，除非它已经成了活链路。 */
export function raceForegroundDial<T>(
  ports: ForegroundDialPorts<T>
): Promise<DirectDialRaceOutcome<T>> {
  return runDirectDialRace<T>({
    dc: ports.dc,
    ws: ports.ws,
    wsFirst: ports.wsFirst,
    signal: ports.signal,
    budgetMs: FOREGROUND_DC_BUDGET_MS,
    deadlineMs: FOREGROUND_DIRECT_DEADLINE_MS,
    now: () => ports.scheduler.now(),
    sleep: (ms, signal) => ports.scheduler.sleep(ms, signal),
    log: ports.log,
    discard: (_kind, session, winner) => {
      if (session === winner || ports.live() === session) return;
      ports.close(session, 'dial-race-lost');
    },
  });
}
