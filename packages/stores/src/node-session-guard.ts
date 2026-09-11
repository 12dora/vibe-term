// 每 node 的 WS 4401 恢复策略：**一次 4401 是假设，不是判决**。
//
// 目标 node 的网关对任何一次流拆除都回 4401（链路抖动、入口侧流迁移、中转流重置），
// 而不只是「会话真的失效了」。就地把该 node 判成未登录，会把整棵子树退回「登录此节点」，
// 而连接又已经停掉——现网 2.0.7 的表现就是设备永远停在「连接中…」。
//
// 因此 4401 之后先用一次**带会话**的 HTTP 探测问一句「会话还在吗」，再决定怎么处置：
//   * 探测成功：会话有效，这次 4401 是瞬时故障 → 退避重连，登录态一动不动；
//     同一窗口内连续 N 次「探测成功但 WS 又被 4401 踢」才判定这台 node 真的有问题。
//   * 探测回 401 `NODE_LOGIN_REQUIRED`：静默重登一次。重登成功 → 重连；这一轮已经重登过
//     （`skipped`）→ 照样重连，但计入上面那个次数；重登失败 → 判定这台 node 真的有问题。
//   * 探测本身打不通（node 不可达）：不可达不是鉴权结论 → 只重连，不计次数；重连间隔另有
//     下限（宿主把「这台 node 的不可达退避还剩多久」喂进来），不去反复撞注定打不通的链路。
//
// **判定之后不是死胡同**：留一条 10 分钟一次的慢速重连；页面重新可见 / 网络恢复时宿主调
// `resume()` 立刻重试。只有**重登真的失败**那一档才顺带把该 node 标未登录（界面这才会出现
// 「登录此节点」按钮，用户点得动）——探测明明说会话有效的那档不动登录态：HTTP 已经证明
// 会话在，翻它只会让界面撒谎，而重连仍在按 10 分钟的节奏自己试。

import {
  createNodeApiClient,
  fetchDevices,
  isNodeLoginRequiredError,
  sessionProbeTimeoutMs,
} from '@vibeterm/api-client';
import { resetDirectAuthorizeBreakers } from '@vibeterm/ws-client/direct/direct-authorize-breaker';

/** 探测结论：会话有效 / 该 node 要重新登录 / 根本没问到（不可达、网络错误）。 */
export type NodeSessionProbe = 'ok' | 'login-required' | 'unreachable';

/** 静默重登的三种结局：成功 / 这一轮已经登过一次 / 失败。 */
export type NodeReloginResult = 'recovered' | 'skipped' | 'failed';

/** 同一窗口内允许「探测说会话没问题、WS 却仍被踢」的次数，超过即判定该 node 有问题。 */
export const DEFAULT_MAX_TRANSIENT_4401 = 3;

/** 上面那个计数的滑动窗口。 */
export const DEFAULT_TRANSIENT_WINDOW_MS = 5 * 60_000;

/** 判定之后的慢速重连间隔。 */
export const GIVE_UP_RECONNECT_MS = 10 * 60_000;

/** 探测超时下限：无 EWMA 时 8s，高 RTT 由 `sessionProbeTimeoutMs` 放大到 30s。 */
export const PROBE_TIMEOUT_MS = 8_000;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** 缺省探测：拉一次该 node 的设备列表，最便宜的「带会话」端点。 */
export async function probeNodeSessionByDevices(nodeId: string): Promise<NodeSessionProbe> {
  const client = createNodeApiClient(nodeId);
  try {
    await fetchDevices(client, {
      signal: AbortSignal.timeout(sessionProbeTimeoutMs(client.lastLatencyMs())),
    });
    return 'ok';
  } catch (error) {
    return isNodeLoginRequiredError(error) ? 'login-required' : 'unreachable';
  }
}

export interface NodeSessionGuardOptions {
  /** 会话探测（宿主 / 测试注入）；缺省拉一次该 node 的设备列表。 */
  probe?: (nodeId: string) => Promise<NodeSessionProbe>;
  /** 静默重登；宿主不接时探测回 `login-required` 即直接判定有问题。 */
  relogin?: (nodeId: string) => Promise<NodeReloginResult>;
  /** 判定为瞬时故障后的重连动作。 */
  reconnect: (nodeId: string) => void;
  /** 判定该 node 确实要重新登录：派事件，界面据此提示。 */
  onLoginRequired: (nodeId: string) => void;
  /**
   * 把该 node 在列表里标未登录——界面上的「登录此节点」按钮只由它驱动。
   * **只在静默重登真的失败时调**：那一刻才有「这台 node 的会话确实不能用了」的证据。
   */
  markLoggedOut?: (nodeId: string) => void;
  /** 重连间隔的下限（宿主按该 node 的不可达退避给出），缺省 0。 */
  reconnectDelayFloorMs?: (nodeId: string) => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
  maxTransient?: number;
  windowMs?: number;
}

interface GuardRecord {
  /** 窗口内「探测说会话没问题、WS 却仍被踢」的时间点。 */
  transientAt: number[];
  /** 连续 4401 的次数，只用来算重连退避。 */
  streak: number;
  lastAt: number;
  running: boolean;
  /** 已判定这台 node 有问题：只留慢速重连。 */
  gaveUp: boolean;
  timer: unknown;
}

function emptyRecord(): GuardRecord {
  return { transientAt: [], streak: 0, lastAt: 0, running: false, gaveUp: false, timer: null };
}

export class NodeSessionGuard {
  private readonly records = new Map<string, GuardRecord>();

  constructor(private readonly options: NodeSessionGuardOptions) {}

  private get maxTransient(): number {
    return this.options.maxTransient ?? DEFAULT_MAX_TRANSIENT_4401;
  }

  private get windowMs(): number {
    return this.options.windowMs ?? DEFAULT_TRANSIENT_WINDOW_MS;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** 收到一次非 self 的 4401：探测后再决定重连还是判定该 node 要重新登录。 */
  handle(nodeId: string): Promise<void> {
    const record = this.record(nodeId);
    // 上一轮恢复还在跑：那一轮的结论会覆盖这一次，重复探测只是白发请求。
    if (record.running) return Promise.resolve();
    record.running = true;
    return this.recover(nodeId, record).finally(() => {
      record.running = false;
    });
  }

  /** 该 node 的运行时被回收：清掉计数与待发的重连。 */
  forget(nodeId: string): void {
    const record = this.records.get(nodeId);
    if (!record) return;
    this.clearTimer(record);
    this.records.delete(nodeId);
  }

  dispose(): void {
    for (const nodeId of [...this.records.keys()]) this.forget(nodeId);
  }

  /**
   * 页面重新可见 / 网络恢复：把待发的重连提到现在，计数与判定一并倒回起点。
   * 判定过「有问题」的那些尤其要走这一条——否则用户只能干等下一个 10 分钟。
   */
  resume(): void {
    for (const [nodeId, record] of [...this.records.entries()]) {
      const pending = record.timer !== null || record.gaveUp;
      this.reset(record);
      if (pending) this.options.reconnect(nodeId);
    }
  }

  private record(nodeId: string): GuardRecord {
    let record = this.records.get(nodeId);
    if (!record) {
      record = emptyRecord();
      this.records.set(nodeId, record);
    }
    const at = this.now();
    // 距上一次 4401 已经超过一个窗口：这是新的一轮，退避、计数与判定都从头来。
    if (record.lastAt !== 0 && at - record.lastAt > this.windowMs) {
      record.transientAt = [];
      record.streak = 0;
      record.gaveUp = false;
    }
    record.lastAt = at;
    return record;
  }

  private async recover(nodeId: string, record: GuardRecord): Promise<void> {
    const probe = this.options.probe ?? probeNodeSessionByDevices;
    const result = await probe(nodeId).catch((): NodeSessionProbe => 'unreachable');
    if (result === 'login-required') {
      await this.afterLoginRequired(nodeId, record);
      return;
    }
    // 不可达不是鉴权结论：不计次数，只按退避重连。
    if (result === 'unreachable') {
      this.scheduleReconnect(nodeId, record);
      return;
    }
    if (!this.noteTransient(record)) {
      this.giveUp(nodeId, record);
      return;
    }
    this.scheduleReconnect(nodeId, record);
  }

  private async afterLoginRequired(nodeId: string, record: GuardRecord): Promise<void> {
    const relogin = this.options.relogin;
    const result = relogin
      ? await relogin(nodeId).catch((): NodeReloginResult => 'failed')
      : 'failed';
    if (result === 'failed') {
      // 只有这一档动登录态：重登失败 = 会话确实不能用了，界面必须给出登录入口。
      this.giveUp(nodeId, record, { markLoggedOut: true });
      return;
    }
    if (result === 'recovered') {
      // 重登成功：这一轮的计数作废，重连按第一次的退避走。
      resetDirectAuthorizeBreakers();
      record.transientAt = [];
      record.streak = 0;
      this.scheduleReconnect(nodeId, record);
      return;
    }
    // `skipped` = 这一轮已经重登过一次（会话理应是好的），照样重连；但必须计次数，
    // 否则「401 → 已登过 → 重连 → 401」就是一个不收敛的活锁。
    if (!this.noteTransient(record)) {
      this.giveUp(nodeId, record);
      return;
    }
    this.scheduleReconnect(nodeId, record);
  }

  /**
   * 这一轮不再快速重试：派事件（界面据此提示），并留一条慢速重连——链路自己恢复时
   * 用户不必手动点任何东西。
   *
   * `markLoggedOut` 只在重登失败那一档给：探测说会话有效却仍被踢，把它标成未登录属于
   * 拿不出证据的结论，界面会显示一个其实并不需要的登录入口（点下去也只是原地登一次）。
   */
  private giveUp(
    nodeId: string,
    record: GuardRecord,
    options: { markLoggedOut?: boolean } = {}
  ): void {
    this.clearTimer(record);
    record.transientAt = [];
    record.streak = 0;
    record.gaveUp = true;
    if (options.markLoggedOut) this.options.markLoggedOut?.(nodeId);
    this.options.onLoginRequired(nodeId);
    this.arm(nodeId, record, GIVE_UP_RECONNECT_MS);
  }

  /** 记一次「探测说会话没问题、WS 却仍被踢」；仍在允许次数内返回 true。 */
  private noteTransient(record: GuardRecord): boolean {
    const at = this.now();
    record.transientAt = record.transientAt.filter((stamp) => at - stamp <= this.windowMs);
    record.transientAt.push(at);
    return record.transientAt.length <= this.maxTransient;
  }

  private scheduleReconnect(nodeId: string, record: GuardRecord): void {
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** record.streak, RECONNECT_MAX_MS);
    record.streak += 1;
    const floor = this.options.reconnectDelayFloorMs?.(nodeId) ?? 0;
    this.arm(nodeId, record, Math.max(backoff, floor));
  }

  /**
   * 排一次重连。`forget()` 与这次恢复是并发的（探测是异步的），所以排之前、以及定时器真的
   * 烧起来时，都要确认这条记录还在册：运行时都回收了还去 connect，等于把已经 dispose 的
   * 连接又拉起来。
   */
  private arm(nodeId: string, record: GuardRecord, delay: number): void {
    if (this.records.get(nodeId) !== record) return;
    this.clearTimer(record);
    const schedule = this.options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    record.timer = schedule(() => {
      record.timer = null;
      if (this.records.get(nodeId) !== record) return;
      this.options.reconnect(nodeId);
    }, delay);
  }

  private clearTimer(record: GuardRecord): void {
    if (record.timer === null) return;
    const cancel =
      this.options.cancel ??
      ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    cancel(record.timer);
    record.timer = null;
  }

  private reset(record: GuardRecord): void {
    this.clearTimer(record);
    record.transientAt = [];
    record.streak = 0;
    record.gaveUp = false;
  }
}
