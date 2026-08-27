import { wsBorsh } from '@tmex/shared';
import type { Carrier } from '../../ws/carrier';
import type { GatewaySession } from '../../ws/gateway-session';

export type ControlSendStatus = 'sent' | 'queued-backpressure' | 'blocked' | 'closed';

export type SendControl = (
  session: GatewaySession,
  kind: number,
  payload: Uint8Array
) => ControlSendStatus | Promise<ControlSendStatus>;

export type AttachDirectOptions = {
  rtcSession?: string;
};

export type DeliverInbound = (session: GatewaySession, bytes: Uint8Array) => void;

export type DirectCarrier = Carrier & {
  onMessage?(cb: (bytes: Uint8Array) => void): void;
  onClose?(cb: () => void): void;
};

export type CarrierSwitchOptions = {
  sendControl: SendControl;
  deliverInbound: DeliverInbound;
};

type SwitchState = {
  epoch: number;
  pendingTo: 'direct' | 'primary' | null;
  flushing: boolean;
  buffer: Uint8Array[];
  direct: DirectCarrier | null;
  rtcSession: string;
  unsubClose: (() => void) | null;
  switchGeneration: number;
  unsubDrain: (() => void) | null;
  closeWaiters: Array<(ok: boolean) => void>;
};

type CloseAwareCarrier = Carrier & {
  onClose?(cb: () => void): void;
};

export class CarrierSwitchController {
  private readonly sendControl: SendControl;
  private readonly deliverInbound: DeliverInbound;
  private readonly states = new WeakMap<GatewaySession, SwitchState>();

  constructor(opts: CarrierSwitchOptions) {
    this.sendControl = opts.sendControl;
    this.deliverInbound = opts.deliverInbound;
  }

  attachDirect(
    session: GatewaySession,
    carrier: DirectCarrier,
    options?: AttachDirectOptions
  ): void {
    const state = this.ensure(session);
    state.direct = carrier;
    state.rtcSession = options?.rtcSession ?? '';
    state.buffer.length = 0;
    state.flushing = false;
    state.unsubClose?.();
    state.unsubDrain?.();
    state.unsubDrain = null;
    state.switchGeneration += 1;
    const generation = state.switchGeneration;
    session.attachCarrier(carrier, 'direct');
    if (carrier.onMessage) {
      carrier.onMessage((bytes) => this.handleDirectInbound(session, bytes));
    }
    if (carrier.onClose) {
      carrier.onClose(() => this.handleDirectClose(session, carrier));
      state.unsubClose = () => {};
    }
    const payload = this.beginSwitch(state, 'direct');
    const status = this.sendSwitch(session, payload);
    if (this.isThenable(status)) {
      void this.finishOutboundSwitch(session, state, carrier, generation, status);
      return;
    }
    const normalized = normalizeControlStatus(status);
    if (normalized === 'sent') {
      if (state.switchGeneration === generation && !session.closed) {
        session.switchActiveCarrier(carrier);
      }
      return;
    }
    if (normalized === 'queued-backpressure') {
      void this.finishQueuedSwitch(session, state, carrier, generation);
      return;
    }
    if (normalized === 'blocked') {
      void this.retryOutboundSwitch(session, state, carrier, generation, payload);
      return;
    }
    this.cancelPendingSwitch(session, state, carrier, generation);
  }

  notifyClosed(session: GatewaySession): void {
    const state = this.states.get(session);
    if (!state) return;
    state.switchGeneration += 1;
    const waiters = state.closeWaiters.splice(0);
    for (const waiter of waiters) waiter(false);
    state.unsubDrain?.();
    state.unsubDrain = null;
    const direct = state.direct;
    state.direct = null;
    state.pendingTo = null;
    state.buffer.length = 0;
    state.flushing = false;
    if (direct) {
      try {
        direct.close(1000, 'session-closed');
      } catch {
        // already closing
      }
      if (session.activeCarrier === direct) {
        session.switchActiveCarrier(session.primary);
      }
      session.detachCarrier(direct);
    }
  }

  handleAck(session: GatewaySession, epoch: number, rtcSession = ''): void {
    const state = this.states.get(session);
    if (!state || state.pendingTo !== 'direct') return;
    if (epoch !== state.epoch) return;
    if (rtcSession !== state.rtcSession) return;
    const direct = session.direct ?? state.direct;
    if (!direct) return;
    state.pendingTo = null;
    this.flush(session, state);
  }

  handleDirectInbound(session: GatewaySession, bytes: Uint8Array): void {
    const state = this.states.get(session);
    if (!state) {
      this.deliverInbound(session, bytes);
      return;
    }
    if (state.pendingTo === 'direct' || state.flushing) {
      state.buffer.push(bytes.slice());
      return;
    }
    this.deliverInbound(session, bytes);
  }

  handleDirectClose(session: GatewaySession, carrier?: Carrier): void {
    const state = this.states.get(session);
    if (session.closed) return;
    if (carrier && state?.direct && carrier !== state.direct) return;
    const direct = carrier ?? session.direct ?? state?.direct;
    if (!direct) return;
    if (session.activeCarrier === direct) {
      session.switchActiveCarrier(session.primary);
    }
    session.detachCarrier(direct);
    if (state) {
      state.direct = null;
      state.buffer.length = 0;
      state.flushing = false;
      state.pendingTo = null;
      state.switchGeneration += 1;
      state.unsubDrain?.();
      state.unsubDrain = null;
      const payload = this.beginSwitch(state, 'primary');
      void this.sendSwitch(session, payload);
    }
  }

  private beginSwitch(state: SwitchState, to: 'direct' | 'primary'): Uint8Array {
    state.epoch = (state.epoch + 1) >>> 0;
    state.pendingTo = to === 'direct' ? 'direct' : null;
    return this.encodeSwitch(state, to);
  }

  private encodeSwitch(state: SwitchState, to: 'direct' | 'primary'): Uint8Array {
    return wsBorsh.encodePayload(wsBorsh.schema.CarrierSwitchSchema, {
      epoch: state.epoch,
      to: to === 'direct' ? wsBorsh.CARRIER_SWITCH_TO_DIRECT : wsBorsh.CARRIER_SWITCH_TO_PRIMARY,
      rtcSession: state.rtcSession,
    });
  }

  private sendSwitch(session: GatewaySession, payload: Uint8Array) {
    return this.sendControl(session, wsBorsh.KIND_CARRIER_SWITCH, payload);
  }

  private async finishOutboundSwitch(
    session: GatewaySession,
    state: SwitchState,
    carrier: DirectCarrier,
    generation: number,
    pending: Promise<ControlSendStatus>
  ): Promise<void> {
    let status: ControlSendStatus;
    try {
      status = normalizeControlStatus(await pending);
    } catch {
      this.cancelPendingSwitch(session, state, carrier, generation);
      return;
    }
    if (status === 'sent') {
      if (state.switchGeneration === generation && !session.closed) {
        session.switchActiveCarrier(carrier);
      }
      return;
    }
    if (status === 'queued-backpressure') {
      await this.finishQueuedSwitch(session, state, carrier, generation);
      return;
    }
    if (status === 'blocked') {
      await this.retryOutboundSwitch(session, state, carrier, generation, null);
      return;
    }
    this.cancelPendingSwitch(session, state, carrier, generation);
  }

  private async finishQueuedSwitch(
    session: GatewaySession,
    state: SwitchState,
    carrier: DirectCarrier,
    generation: number
  ): Promise<void> {
    const drained = await this.waitDrain(session, state, generation);
    if (!drained || state.switchGeneration !== generation || session.closed) {
      this.cancelPendingSwitch(session, state, carrier, generation);
      return;
    }
    session.switchActiveCarrier(carrier);
  }

  private async retryOutboundSwitch(
    session: GatewaySession,
    state: SwitchState,
    carrier: DirectCarrier,
    generation: number,
    payload: Uint8Array | null
  ): Promise<void> {
    const frame = payload ?? this.encodeSwitch(state, 'direct');
    while (state.switchGeneration === generation && !session.closed) {
      const drained = await this.waitDrain(session, state, generation);
      if (!drained) break;
      const status = normalizeControlStatus(await this.sendSwitch(session, frame));
      if (status === 'sent' || status === 'queued-backpressure') {
        if (status === 'queued-backpressure') {
          const drainedAgain = await this.waitDrain(session, state, generation);
          if (!drainedAgain) break;
        }
        if (state.switchGeneration === generation && !session.closed) {
          session.switchActiveCarrier(carrier);
        }
        return;
      }
      if (status === 'closed') break;
    }
    this.cancelPendingSwitch(session, state, carrier, generation);
  }

  private waitDrain(
    session: GatewaySession,
    state: SwitchState,
    generation: number
  ): Promise<boolean> {
    if (session.closed || state.switchGeneration !== generation) return Promise.resolve(false);
    const carrier = session.activeCarrier as CloseAwareCarrier;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        state.unsubDrain = null;
        const idx = state.closeWaiters.indexOf(onClosed);
        if (idx >= 0) state.closeWaiters.splice(idx, 1);
        resolve(ok);
      };
      const onDrain = () => finish(true);
      const onClosed = () => finish(false);
      carrier.onDrain(onDrain);
      if (typeof carrier.onClose === 'function') {
        carrier.onClose(onClosed);
      }
      state.closeWaiters.push(onClosed);
      state.unsubDrain = () => finish(false);
    });
  }

  private cancelPendingSwitch(
    session: GatewaySession,
    state: SwitchState,
    carrier: DirectCarrier,
    generation: number
  ): void {
    if (state.switchGeneration !== generation) return;
    state.unsubDrain?.();
    state.unsubDrain = null;
    state.pendingTo = null;
    if (state.direct === carrier) {
      state.direct = null;
      state.buffer.length = 0;
      if (session.activeCarrier === carrier) {
        session.switchActiveCarrier(session.primary);
      }
      session.detachCarrier(carrier);
    }
  }

  private isThenable(value: unknown): value is Promise<ControlSendStatus> {
    return typeof value === 'object' && value !== null && 'then' in value;
  }

  private flush(session: GatewaySession, state: SwitchState): void {
    state.flushing = true;
    try {
      while (state.buffer.length > 0) {
        const next = state.buffer.shift();
        if (!next) break;
        this.deliverInbound(session, next);
      }
    } finally {
      state.flushing = false;
    }
    if (state.buffer.length > 0) this.flush(session, state);
  }

  private ensure(session: GatewaySession): SwitchState {
    let state = this.states.get(session);
    if (!state) {
      state = {
        epoch: 0,
        pendingTo: null,
        flushing: false,
        buffer: [],
        direct: null,
        rtcSession: '',
        unsubClose: null,
        switchGeneration: 0,
        unsubDrain: null,
        closeWaiters: [],
      };
      this.states.set(session, state);
    }
    return state;
  }
}

function normalizeControlStatus(
  status: ControlSendStatus | boolean | 'backpressure' | 'backpressured' | 'dropped' | undefined
): ControlSendStatus {
  if (status === 'queued-backpressure') return 'queued-backpressure';
  if (status === 'blocked') return 'blocked';
  if (status === 'backpressure' || status === 'backpressured') return 'queued-backpressure';
  if (status === 'closed' || status === 'dropped' || status === false) return 'closed';
  return 'sent';
}
