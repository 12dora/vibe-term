import type { Login } from './encoding';
import { DOMAIN_LOGIN, bytesEqual, encodeLogin } from './encoding';
import { signEd25519, verifyEd25519 } from './root-key';

export type LoginErrorCode =
  | 'challenge_mismatch'
  | 'target_mismatch'
  | 'uid_mismatch'
  | 'entry_mismatch'
  | 'bad_signature';

export type VerifyLoginExpected = {
  challengeId: string;
  nonce: Uint8Array;
  target: string;
  targetPk: Uint8Array;
  uid: string;
  entry: string;
};

export type VerifyLoginResult = { ok: true } | { ok: false; error: LoginErrorCode };

export function buildLogin(fields: {
  challengeId: string;
  nonce: Uint8Array;
  target: string;
  targetPk: Uint8Array;
  uid: string;
  entry: string;
}): Login {
  if (fields.nonce.length !== 32) {
    throw new Error('nonce must be 32 bytes');
  }
  if (fields.targetPk.length !== 32) {
    throw new Error('targetPk must be 32 bytes');
  }
  return {
    domain: DOMAIN_LOGIN,
    challenge_id: fields.challengeId,
    nonce: new Uint8Array(fields.nonce),
    target: fields.target,
    target_pk: new Uint8Array(fields.targetPk),
    uid: fields.uid,
    entry: fields.entry,
  };
}

export function signLogin(sessSk: Uint8Array, login: Login): Uint8Array {
  return signEd25519(sessSk, encodeLogin(login));
}

export function verifyLogin(
  login: Login,
  sig: Uint8Array,
  sessPk: Uint8Array,
  expected: VerifyLoginExpected
): VerifyLoginResult {
  if (login.challenge_id !== expected.challengeId || !bytesEqual(login.nonce, expected.nonce)) {
    return { ok: false, error: 'challenge_mismatch' };
  }
  if (login.target !== expected.target || !bytesEqual(login.target_pk, expected.targetPk)) {
    return { ok: false, error: 'target_mismatch' };
  }
  if (login.uid !== expected.uid) {
    return { ok: false, error: 'uid_mismatch' };
  }
  if (login.entry !== expected.entry) {
    return { ok: false, error: 'entry_mismatch' };
  }
  if (login.domain !== DOMAIN_LOGIN || !verifyEd25519(sig, encodeLogin(login), sessPk)) {
    return { ok: false, error: 'bad_signature' };
  }
  return { ok: true };
}
