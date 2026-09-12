import { randomBytes } from 'node:crypto';
import {
  ATTR,
  CLASS,
  type StunMessage,
  encodeMessage,
  errorAttribute,
  getAttribute,
  longTermKey,
  textAttribute,
  verifyIntegrity,
} from './stun-message';
import type { SocketAddress, TurnContext } from './turn-context';
import { NONCE_GRACE_MS, NONCE_LIFETIME_MS } from './turn-limits';

export class NonceStore {
  private currentValue: string;
  private currentAt: number;
  private previousValue: string | null = null;
  private previousAt = 0;

  constructor(private readonly now: () => number) {
    this.currentValue = newNonce();
    this.currentAt = now();
  }

  current(): string {
    this.rotateIfNeeded();
    return this.currentValue;
  }

  classify(nonce: string | undefined): 'ok' | 'stale' | 'missing' {
    this.rotateIfNeeded();
    if (!nonce) return 'missing';
    if (nonce === this.currentValue) return 'ok';
    if (this.previousStillValid(nonce)) return 'ok';
    return 'stale';
  }

  private previousStillValid(nonce: string): boolean {
    if (this.previousValue === null || nonce !== this.previousValue) return false;
    return this.now() - this.previousAt < NONCE_LIFETIME_MS + NONCE_GRACE_MS;
  }

  private rotateIfNeeded(): void {
    const now = this.now();
    if (now - this.currentAt < NONCE_LIFETIME_MS) return;
    this.previousValue = this.currentValue;
    this.previousAt = this.currentAt;
    this.currentValue = newNonce();
    this.currentAt = now;
  }
}

function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export type AuthOk = { ok: true; user: string; password: string; key: Buffer };
export type AuthFail = { ok: false; code: 401 | 438 };
export type AuthResult = AuthOk | AuthFail;

export function authenticateRequest(
  msg: StunMessage,
  realm: string,
  credentials: (user: string) => string | null,
  nonce: NonceStore
): AuthResult {
  const username = getAttribute(msg, ATTR.USERNAME)?.toString('utf8');
  const msgRealm = getAttribute(msg, ATTR.REALM)?.toString('utf8');
  const msgNonce = getAttribute(msg, ATTR.NONCE)?.toString('utf8');
  const nonceState = nonce.classify(msgNonce);
  if (nonceState === 'missing') return { ok: false, code: 401 };
  if (nonceState === 'stale') return { ok: false, code: 438 };
  if (!username || msgRealm !== realm) return { ok: false, code: 401 };
  const password = credentials(username);
  if (!password) return { ok: false, code: 401 };
  const key = longTermKey(username, realm, password);
  if (!verifyIntegrity(msg, key)) return { ok: false, code: 401 };
  return { ok: true, user: username, password, key };
}

export function sendChallenge(
  ctx: TurnContext,
  msg: StunMessage,
  addr: SocketAddress,
  code: 401 | 438
): void {
  if (!ctx.unauthLimit.allow(addr.address)) {
    ctx.stats.droppedUnauthRateLimit++;
    return;
  }
  ctx.stats.authFailures++;
  const reason = code === 438 ? 'Stale Nonce' : 'Unauthorized';
  ctx.send(
    encodeMessage({
      method: msg.method,
      class: CLASS.ERROR,
      transactionId: msg.transactionId,
      attributes: [
        errorAttribute(code, reason),
        textAttribute(ATTR.REALM, ctx.options.realm),
        textAttribute(ATTR.NONCE, ctx.nonce.current()),
      ],
      fingerprint: true,
    }),
    addr
  );
}
