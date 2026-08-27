import { type BorshSessionState, createBorshSessionState } from './borsh/codec-borsh';
import { type SessionState, createSessionState } from './borsh/session-state';
import type { Carrier } from './carrier';

export type CarrierRole = 'primary' | 'direct';

export class GatewaySession {
  readonly id: string;
  borshState: BorshSessionState;
  readonly state: SessionState;
  readonly primary: Carrier;
  direct: Carrier | null = null;
  activeCarrier: Carrier;
  closed = false;

  constructor(options: {
    id?: string;
    primary: Carrier;
    borshState?: BorshSessionState;
    state?: SessionState;
  }) {
    this.id = options.id ?? crypto.randomUUID();
    this.primary = options.primary;
    this.activeCarrier = options.primary;
    this.borshState = options.borshState ?? createBorshSessionState();
    this.state = options.state ?? createSessionState();
  }

  attachCarrier(carrier: Carrier, role: CarrierRole): void {
    if (this.closed) return;
    if (role === 'primary') {
      return;
    }
    this.direct = carrier;
  }

  detachCarrier(carrier: Carrier): void {
    if (carrier === this.direct) {
      this.direct = null;
      if (this.activeCarrier === carrier) {
        this.activeCarrier = this.primary;
      }
      return;
    }
    if (carrier === this.primary && this.direct) {
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
