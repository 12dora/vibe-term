import { type BorshSessionState, createBorshSessionState } from './borsh/codec-borsh';
import { type SessionState, createSessionState } from './borsh/session-state';
import type { Carrier } from './carrier';
import type { ShareScope } from './share-scope';
import type { ViewportClaim } from './viewport-policy';

export type CarrierRole = 'primary' | 'direct';

const DIRECT_REPLACED_CLOSE_CODE = 1000;
const DIRECT_REPLACED_CLOSE_REASON = 'direct carrier replaced';

export class GatewaySession {
  readonly id: string;
  /**
   * 本条 Gateway WS 在 SessionRegistry 里的服务端 id。登记后写回；HELLO_S2C
   * 用它生成 `connection-id:` 能力串。未登记时为 null（老路径走 GET connection）。
   */
  connectionId: string | null = null;
  borshState: BorshSessionState;
  readonly state: SessionState;
  readonly primary: Carrier;
  direct: Carrier | null = null;
  activeCarrier: Carrier;
  closed = false;
  /** 非空即「分享连接」：只看得到 scope 指定的 window，出入站都按 scope 过滤。 */
  shareScope?: ShareScope;
  onCarrierDetached: ((carrier: Carrier) => void) | null = null;
  onDirectFallback: (() => void) | null = null;
  readonly viewportClaims = new Map<string, ViewportClaim>();
  /** canonical v1.1 尺寸 epoch：`deviceId\0paneId` → 已接受的最大 sizeEpoch，用于丢弃过期尺寸。 */
  readonly paneSizeEpochs = new Map<string, bigint>();
  /** 最近一次收到本会话任意入站帧的时刻（ms），任何 carrier 都算。 */
  lastInboundAt: number;
  /** 已知会定时发 PING（自家客户端的 HELLO，或实际发过 PING）：只有这类会话才能按入站静默判定失联。 */
  heartbeatExpected = false;
  /** 失联巡检已为本次静默重算过视口；收到入站帧即复位。 */
  staleSwept = false;
  /** 失联后先到的是分片：等整条消息重组并处理完再按最新声明重算一次视口。 */
  reviveRecomputePending = false;
  /**
   * 空闲回收能否用 4408 关掉本会话：直连浏览器 WS 恒可以；mesh 流仅当入口在 OPEN 上声明了
   * `idleClose`（旧入口会把 4408 当链路抖动 failover，重放缓存的 HELLO 与视口声明复活会话）。
   */
  idleClosable = false;

  constructor(options: {
    id?: string;
    primary: Carrier;
    borshState?: BorshSessionState;
    state?: SessionState;
    now?: number;
  }) {
    this.id = options.id ?? crypto.randomUUID();
    this.lastInboundAt = options.now ?? Date.now();
    this.primary = options.primary;
    this.activeCarrier = options.primary;
    this.borshState = options.borshState ?? createBorshSessionState();
    this.state = options.state ?? createSessionState();
  }

  carriers(): Carrier[] {
    return this.direct ? [this.primary, this.direct] : [this.primary];
  }

  attachCarrier(carrier: Carrier, role: CarrierRole): void {
    if (this.closed) return;
    if (carrier === this.primary || carrier === this.direct) {
      throw new Error('carrier is already attached to this session');
    }
    if (role === 'primary') {
      return;
    }
    const previous = this.direct;
    if (previous) {
      if (this.activeCarrier === previous) {
        this.activeCarrier = this.primary;
      }
      this.detachCarrier(previous);
      try {
        previous.close(DIRECT_REPLACED_CLOSE_CODE, DIRECT_REPLACED_CLOSE_REASON);
      } catch {
        // The previous direct may already be closing.
      }
    }
    this.direct = carrier;
  }

  detachCarrier(carrier: Carrier): void {
    if (carrier === this.direct) {
      this.direct = null;
      if (this.activeCarrier === carrier) {
        this.activeCarrier = this.primary;
      }
      this.onCarrierDetached?.(carrier);
      return;
    }
    if (carrier === this.primary && this.direct && !this.closed) {
      this.activeCarrier = this.direct;
    }
  }

  switchActiveCarrier(carrier: Carrier): void {
    if (carrier !== this.primary && carrier !== this.direct) {
      throw new Error('carrier is not attached to this session');
    }
    this.activeCarrier = carrier;
  }

  isActiveCarrier(carrier: Carrier): boolean {
    return !this.closed && this.activeCarrier === carrier;
  }

  handleCarrierDrain(carrier: Carrier): boolean {
    return this.isActiveCarrier(carrier);
  }
}
