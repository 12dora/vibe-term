import { describe, expect, it } from 'bun:test';
import { buildLogin, signLogin, verifyLogin } from './login';
import { generateEd25519KeyPair } from './root-key';

const expected = {
  challengeId: 'ch-1',
  nonce: new Uint8Array(32).fill(1),
  target: 'node-t',
  targetPk: new Uint8Array(32).fill(2),
  uid: 'user-1',
  entry: 'node-e',
};

describe('login', () => {
  const sess = generateEd25519KeyPair();

  it('signs and verifies a matching login', () => {
    const login = buildLogin(expected);
    const sig = signLogin(sess.secretKey, login);
    expect(verifyLogin(login, sig, sess.publicKey, expected)).toEqual({ ok: true });
  });

  it('returns challenge_mismatch', () => {
    const login = buildLogin({ ...expected, challengeId: 'other' });
    const sig = signLogin(sess.secretKey, login);
    expect(verifyLogin(login, sig, sess.publicKey, expected)).toEqual({
      ok: false,
      error: 'challenge_mismatch',
    });

    const loginNonce = buildLogin({ ...expected, nonce: new Uint8Array(32).fill(9) });
    const sigNonce = signLogin(sess.secretKey, loginNonce);
    expect(verifyLogin(loginNonce, sigNonce, sess.publicKey, expected)).toEqual({
      ok: false,
      error: 'challenge_mismatch',
    });
  });

  it('returns target_mismatch', () => {
    const login = buildLogin({ ...expected, target: 'other' });
    const sig = signLogin(sess.secretKey, login);
    expect(verifyLogin(login, sig, sess.publicKey, expected)).toEqual({
      ok: false,
      error: 'target_mismatch',
    });

    const loginPk = buildLogin({ ...expected, targetPk: new Uint8Array(32).fill(8) });
    const sigPk = signLogin(sess.secretKey, loginPk);
    expect(verifyLogin(loginPk, sigPk, sess.publicKey, expected)).toEqual({
      ok: false,
      error: 'target_mismatch',
    });
  });

  it('returns uid_mismatch', () => {
    const login = buildLogin({ ...expected, uid: 'other' });
    const sig = signLogin(sess.secretKey, login);
    expect(verifyLogin(login, sig, sess.publicKey, expected)).toEqual({
      ok: false,
      error: 'uid_mismatch',
    });
  });

  it('returns entry_mismatch', () => {
    const login = buildLogin({ ...expected, entry: 'other' });
    const sig = signLogin(sess.secretKey, login);
    expect(verifyLogin(login, sig, sess.publicKey, expected)).toEqual({
      ok: false,
      error: 'entry_mismatch',
    });
  });

  it('returns bad_signature', () => {
    const login = buildLogin(expected);
    const other = generateEd25519KeyPair();
    const sig = signLogin(other.secretKey, login);
    expect(verifyLogin(login, sig, sess.publicKey, expected)).toEqual({
      ok: false,
      error: 'bad_signature',
    });
  });
});
