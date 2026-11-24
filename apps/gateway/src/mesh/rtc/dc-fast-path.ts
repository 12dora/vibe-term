import { logLine } from '../mesh-log';
import { closeChannelQuietly, fastPathCoolingFor } from './data-channel-fast-path';
import type { DataChannelLike, PeerConnectionLike } from './native';
import { rtcLog } from './rtc-log';
import { PEER_CHANNEL_LABEL, logCreatedChannel } from './rtc-peer-helpers';

export const PEER_RT_CHANNEL_LABEL = 'peer-rt';
/** DC hello 里的能力位：两端都带上才建 peer-rt。旧版本不认识 caps 字段，按缺省处理。 */
export const DC_CAP_FAST_PATH = 'peer-rt';
export const PEER_RT_CHANNEL_INIT = { unordered: true, maxRetransmits: 0 } as const;

let disabledLogged = false;

/** `VIBETERM_DC_FAST_PATH=0` 关闭：本端不在 hello 里报能力，对端因此不会建 peer-rt。 */
export function dcFastPathEnabled(): boolean {
  const raw = process.env.VIBETERM_DC_FAST_PATH?.trim().toLowerCase();
  const enabled = !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no');
  if (!enabled && !disabledLogged) {
    disabledLogged = true;
    logLine('[mesh][rtc]', 'dc fast path disabled by VIBETERM_DC_FAST_PATH');
  }
  return enabled;
}

export function resetDcFastPathEnvLogForTest(): void {
  disabledLogged = false;
}

type FastChannelOwner = { attachFastChannel(dc: DataChannelLike): void };

/**
 * 一次 node↔node 握手里 peer-rt 的建立与分流。offerer 在 Link 建好后 createDataChannel；
 * 应答侧拿到 'peer' 之后接管 onDataChannel（native 是单回调 setter）按 label 分流：
 * 'peer' 忽略（与旧版一致），'peer-rt' 交给 Link（Link 未就绪先暂存），其它直接关掉。
 */
export class PeerRtChannels {
  /** 本次握手是否通告能力：开关打开且该对端不在 desync 冷却期。 */
  readonly enabled: boolean;
  private owner: FastChannelOwner | null = null;
  private pending: DataChannelLike | null = null;

  constructor(
    private readonly pc: PeerConnectionLike,
    private readonly peer: string
  ) {
    this.enabled = dcFastPathEnabled() && !fastPathCoolingFor(peer);
  }

  routeInbound(): void {
    if (!this.enabled) return;
    this.pc.onDataChannel((dc) => {
      const label = dc.getLabel?.() ?? '';
      if (label === PEER_CHANNEL_LABEL) return;
      if (label !== PEER_RT_CHANNEL_LABEL) {
        rtcLog('datachannel ignored', { peer: this.peer, label });
        closeChannelQuietly(dc);
        return;
      }
      if (this.owner) {
        this.owner.attachFastChannel(dc);
        return;
      }
      closeChannelQuietly(this.pending);
      this.pending = dc;
    });
  }

  bind(owner: FastChannelOwner, offerer: boolean, negotiated: boolean): void {
    if (offerer) {
      if (negotiated) this.openOutbound(owner);
      return;
    }
    this.owner = owner;
    const pending = this.pending;
    this.pending = null;
    if (pending) owner.attachFastChannel(pending);
  }

  dispose(): void {
    closeChannelQuietly(this.pending);
    this.pending = null;
  }

  private openOutbound(owner: FastChannelOwner): void {
    let dc: DataChannelLike;
    try {
      dc = this.pc.createDataChannel(PEER_RT_CHANNEL_LABEL, PEER_RT_CHANNEL_INIT);
    } catch (err) {
      rtcLog('fast path create failed', {
        peer: this.peer,
        err: err instanceof Error ? err.message : err,
      });
      return;
    }
    logCreatedChannel(dc, this.peer);
    owner.attachFastChannel(dc);
  }
}
