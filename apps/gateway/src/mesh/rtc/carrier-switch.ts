import { wsBorsh } from '@tmex/shared';
import type { Carrier } from '../../ws/carrier';
import type { GatewaySession } from '../../ws/gateway-session';

export type SendControl = (session: GatewaySession, kind: number, payload: Uint8Array) => void;

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
  unsubClose: (() => void) | null;
};

export class CarrierSwitchController {
  private readonly sendControl: SendControl;
  private readonly deliverInbound: DeliverInbound;
  private readonly states = new WeakMap<GatewaySession, SwitchState>();

  constructor(opts: CarrierSwitchOptions) {
    this.sendControl = opts.sendControl;
    this.deliverInbound = opts.deliverInbound;
  }

  attachDirect(session: GatewaySession, carrier: DirectCarrier): void {
    const state = this.ensure(session);
    state.direct = carrier;
    state.buffer.length = 0;
    state.flushing = false;
    state.unsubClose?.();
    session.attachCarrier(carrier, 'direct');
    if (carrier.onMessage) {
      carrier.onMessage((bytes) => this.handleDirectInbound(session, bytes));
    }
    if (carrier.onClose) {
      carrier.onClose(() => this.handleDirectClose(session, carrier));
      state.unsubClose = () => {};
    }
    this.sendSwitch(session, state, 'direct');
  }

  handleAck(session: GatewaySession, epoch: number): void {
    const state = this.states.get(session);
    if (!state || state.pendingTo !== 'direct') return;
    if (epoch !== state.epoch) return;
    const direct = session.direct ?? state.direct;
    if (!direct) return;
    state.pendingTo = null;
    session.switchActiveCarrier(direct);
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
      this.sendSwitch(session, state, 'primary');
    }
  }

  private sendSwitch(session: GatewaySession, state: SwitchState, to: 'direct' | 'primary'): void {
    state.epoch = (state.epoch + 1) >>> 0;
    state.pendingTo = to === 'direct' ? 'direct' : null;
    const payload = wsBorsh.encodePayload(wsBorsh.schema.CarrierSwitchSchema, {
      epoch: state.epoch,
      to: to === 'direct' ? wsBorsh.CARRIER_SWITCH_TO_DIRECT : wsBorsh.CARRIER_SWITCH_TO_PRIMARY,
    });
    this.sendControl(session, wsBorsh.KIND_CARRIER_SWITCH, payload);
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
        unsubClose: null,
      };
      this.states.set(session, state);
    }
    return state;
  }
}
