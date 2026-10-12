import { verifyKeyLogChain } from '../../../shared/src/auth';
import type { RelayJoinTokenEntry, RelayKeyLogEntry } from '../../../shared/src/relay';
import { t } from '../i18n';
import type { FetchLike } from '../lib/fetch-like';
import { makeReplayPasskeyVerifier } from '../lib/keylog-passkey-replay';
import { fetchRelayKeyLog } from '../lib/relay-keylog';
import { isRelayUnreachable } from '../lib/relay-unreachable';
import type { ParsedArgs } from '../types';
import type { CliIo } from './cli-io';
import { JoinError, NODE_REVOKED_REJOIN_ERROR } from './join-error';
import { joinDoneKey } from './relay-join-summary';
import { RelayApiError } from './relay-shared';
import type { RestartOutcome } from './restart';

export const RELAY_JOIN_POLL_INTERVAL_MS = 3_000;
/** 与网页端加入码的有效期一致。 */
export const RELAY_JOIN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
/** 约定俗成的 SIGINT 退出码（128 + 2）。 */
export const INTERRUPT_EXIT_CODE = 130;

/** redeem 之后、等待现有设备批准（`admit-node`）期间用来盯中继密钥日志的上下文。 */
export type RelayAdmissionWatch = {
  entry: RelayJoinTokenEntry;
  headers: Record<string, string>;
  fetcher: FetchLike | undefined;
  logKey: Uint8Array;
  rootPublicKey: Uint8Array;
  nodeIdHex: string;
  records: RelayKeyLogEntry[];
};

export class RelayJoinWaitError extends Error {
  readonly code: 'approval_timeout' | 'interrupted';

  constructor(code: RelayJoinWaitError['code'], message: string) {
    super(message);
    this.name = 'RelayJoinWaitError';
    this.code = code;
  }
}

type AdmissionState = 'pending' | 'admitted' | 'revoked';

/**
 * 轮询期间只有「还没批准」类的情形继续等：中继暂时连不上、响应体读到一半断了，
 * 以及代理层的 408/429/5xx。令牌被拒（401/403/404）、日志验不过都是终止条件。
 */
function isTransientPollError(error: unknown): boolean {
  if (isRelayUnreachable(error)) return true;
  if (!(error instanceof RelayApiError)) return false;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

async function pollAdmission(
  watch: RelayAdmissionWatch,
  io: CliIo,
  signal: AbortSignal
): Promise<AdmissionState> {
  const fresh = await fetchRelayKeyLog({
    relayUrl: watch.entry.url,
    tenantId: watch.entry.tenantId,
    headers: watch.headers,
    logKey: watch.logKey,
    fromSeq: watch.records.length + 1,
    fetcher: watch.fetcher,
    timeoutMs: io.relayTimeoutMs,
    signal,
  });
  if (fresh.length === 0) return 'pending';
  watch.records = [...watch.records, ...fresh];
  const verified = await verifyKeyLogChain(watch.records, watch.rootPublicKey, undefined, {
    verifyPasskeyAssertion: makeReplayPasskeyVerifier(watch.records),
  });
  if (!verified.ok) throw new JoinError('join_failed', `key log rejected: ${verified.error}`);
  const cert = verified.state.nodeCerts.get(watch.nodeIdHex);
  if (!cert) return 'pending';
  return cert.revoked ? 'revoked' : 'admitted';
}

async function pollOnce(
  watch: RelayAdmissionWatch,
  io: CliIo,
  signal: AbortSignal
): Promise<AdmissionState> {
  try {
    return await pollAdmission(watch, io, signal);
  } catch (error) {
    if (isTransientPollError(error)) return 'pending';
    throw error;
  }
}

function waitNextKey(restart: RestartOutcome): string {
  return restart === 'manual' ? 'relay.join.next.restart' : 'relay.join.next.auto';
}

function interrupted(restart: RestartOutcome): RelayJoinWaitError {
  return new RelayJoinWaitError(
    'interrupted',
    t('relay.join.interrupted', { next: t(waitNextKey(restart)) })
  );
}

/** 让正在进行的 await 在中断信号触发时立刻抛出，不必等到请求或休眠自然结束。 */
function abortable<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  onInterrupt: () => RelayJoinWaitError
): Promise<T> {
  if (signal.aborted) return Promise.reject(onInterrupt());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(onInterrupt());
    signal.addEventListener('abort', onAbort, { once: true });
    start()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Ctrl+C 只停止等待。监听器装上就不再摘：终端会把 SIGINT 同时发给父进程和本进程，
 * 父进程还会转发一次，第二个信号到达时若已无监听器会直接杀掉正在收尾的进程。
 */
export function sigintAbortSignal(emitter: NodeJS.EventEmitter = process): AbortSignal {
  const controller = new AbortController();
  emitter.on('SIGINT', () => controller.abort());
  return controller.signal;
}

/**
 * 等现有设备签出本机的 `admit-node`。批准返回；被吊销、等待超时或被中断抛错。
 * 只读中继，不碰本地库——重启后的 gateway 同时在同步同一条日志。
 */
export async function waitForRelayAdmission(
  watch: RelayAdmissionWatch,
  io: CliIo,
  restart: RestartOutcome
): Promise<void> {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? defaultSleep;
  const intervalMs = io.joinPollIntervalMs ?? RELAY_JOIN_POLL_INTERVAL_MS;
  const timeoutMs = io.joinWaitTimeoutMs ?? RELAY_JOIN_WAIT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  const signal = io.interruptSignal ?? sigintAbortSignal();
  const onInterrupt = () => interrupted(restart);
  for (;;) {
    const state = await abortable(() => pollOnce(watch, io, signal), signal, onInterrupt);
    if (state === 'admitted') return;
    if (state === 'revoked') throw new JoinError('node_revoked', NODE_REVOKED_REJOIN_ERROR);
    if (now() >= deadline) {
      const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
      const next = t(waitNextKey(restart));
      throw new RelayJoinWaitError('approval_timeout', t('relay.join.timeout', { minutes, next }));
    }
    await abortable(() => sleep(intervalMs, signal), signal, onInterrupt);
  }
}

function setExitCode(io: CliIo, code: number): void {
  if (io.setExitCode) io.setExitCode(code);
  else process.exitCode = code;
}

/**
 * token 加入的收尾：本机库已在 `withAuth` 里关闭，这里只读中继。已批准则无事可做；
 * `--no-wait` 只提示；否则等到批准，最后一行永远是结论。用户 Ctrl+C 不算失败：
 * 申请仍然有效，打印说明后以 130 退出（不抛错，入口不会把退出码改回 1）。
 */
export async function settleRelayAdmission(
  parsed: ParsedArgs,
  watch: RelayAdmissionWatch | null,
  io: CliIo,
  restart: RestartOutcome
): Promise<void> {
  if (!watch) return;
  const log = io.log ?? console.log;
  if (parsed.flags['no-wait'] === true) {
    log(t(restart === 'manual' ? 'relay.join.pendingLaterRestart' : 'relay.join.pendingLater'));
    return;
  }
  try {
    await waitForRelayAdmission(watch, io, restart);
  } catch (error) {
    if (!(error instanceof RelayJoinWaitError) || error.code !== 'interrupted') throw error;
    log(error.message);
    setExitCode(io, INTERRUPT_EXIT_CODE);
    return;
  }
  log(t(joinDoneKey(restart)));
}
