import type { LinkSession } from '@vibeterm/shared/link';
import { PreauthSocketLimiter } from '../mesh/peer-server';

export const RELAY_PREAUTH_PER_IP = 16;
export const RELAY_PREAUTH_GLOBAL = 256;

export class RelayUplinkPreauth {
  private readonly limiter: PreauthSocketLimiter;
  private readonly held = new WeakMap<LinkSession, string | null>();
  private readonly authTimers = new Map<LinkSession, ReturnType<typeof setTimeout>>();

  constructor(
    perIp: number,
    globalLimit: number,
    private readonly authTimeoutMs: number,
    private readonly shouldTimeout: (link: LinkSession) => boolean,
    private readonly onTimeout: (link: LinkSession) => void
  ) {
    this.limiter = new PreauthSocketLimiter(perIp, globalLimit);
  }

  reserve(key: string | null): boolean {
    return this.limiter.tryAcquire(key);
  }

  releaseReservation(key: string | null): void {
    this.limiter.release(key);
  }

  claim(link: LinkSession, ip: string | null, reserved?: boolean): boolean {
    if (reserved) {
      this.held.set(link, ip);
      return true;
    }
    return this.hold(link, ip);
  }

  drop(link: LinkSession): void {
    if (!this.held.has(link)) return;
    const ip = this.held.get(link) ?? null;
    this.held.delete(link);
    this.limiter.release(ip);
  }

  armAuthTimer(link: LinkSession): void {
    this.clearAuthTimer(link);
    const timer = setTimeout(() => {
      this.authTimers.delete(link);
      if (this.shouldTimeout(link)) this.onTimeout(link);
    }, this.authTimeoutMs);
    this.authTimers.set(link, timer);
  }

  clearAuthTimer(link: LinkSession): void {
    const timer = this.authTimers.get(link);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.authTimers.delete(link);
    }
  }

  clear(): void {
    for (const timer of this.authTimers.values()) clearTimeout(timer);
    this.authTimers.clear();
    this.limiter.clear();
  }

  private hold(link: LinkSession, ip: string | null): boolean {
    if (!this.limiter.tryAcquire(ip)) return false;
    this.held.set(link, ip);
    return true;
  }
}
