import { type BorshSessionState, createBorshSessionState } from './borsh/codec-borsh';
import { type SessionState, createSessionState } from './borsh/session-state';
import type { Carrier } from './carrier';

export type CarrierRole = 'primary' | 'direct';

const DIRECT_REPLACED_CLOSE_CODE = 1000;
const DIRECT_REPLACED_CLOSE_REASON = 'direct carrier replaced';

export class GatewaySession {
  readonly id: string;
  borshState: BorshSessionState;
  readonly state: SessionState;
  readonly primary: Carrier;
  direct: Carrier | null = null;
  activeCarrier: Carrier;
  closed = false;
  onCarrierDetached: ((carrier: Carrier) => void) | null = null;

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
