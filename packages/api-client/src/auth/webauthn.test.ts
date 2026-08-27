import { describe, expect, test } from 'bun:test';
import { encodeBase64url } from '@tmex/shared/auth';
import type { AuthenticationResponseJSON } from './types';
import {
  isWebAuthnAvailable,
  toAuthenticationResponseJSON,
  toCreationOptions,
  toRegistrationResponseJSON,
  toRequestOptions,
} from './webauthn';

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(values.length));
  out.set(values);
  return out;
}

function buffer(values: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(values.length);
  new Uint8Array(out).set(values);
  return out;
}

describe('webauthn 适配层', () => {
  test('creation options 的 base64url 字段转成 ArrayBuffer', () => {
    const challenge = bytes(1, 2, 3, 4);
    const options = toCreationOptions({
      rp: { id: 'example.com', name: 'tmex' },
      user: { id: encodeBase64url(bytes(9, 9)), name: 'alice', displayName: 'alice' },
      challenge: encodeBase64url(challenge),
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      excludeCredentials: [{ id: encodeBase64url(bytes(7)), transports: ['internal'] }],
      authenticatorSelection: { userVerification: 'required' },
    });
    expect(new Uint8Array(options.challenge as ArrayBuffer)).toEqual(challenge);
    expect(new Uint8Array(options.user.id as ArrayBuffer)).toEqual(bytes(9, 9));
    expect(options.excludeCredentials).toHaveLength(1);
    expect(options.excludeCredentials?.[0].type).toBe('public-key');
    expect(options.pubKeyCredParams[0]).toEqual({ alg: -7, type: 'public-key' });
  });

  test('request options 空 allowCredentials 转为 undefined（可发现凭证）', () => {
    const options = toRequestOptions({
      challenge: encodeBase64url(bytes(5)),
      rpId: 'localhost',
      allowCredentials: [],
      userVerification: 'required',
    });
    expect(options.allowCredentials).toBeUndefined();
    expect(options.rpId).toBe('localhost');
    expect(options.userVerification).toBe('required');
  });

  test('assertion 凭证转回 JSON（base64url）', () => {
    const credential = {
      id: 'cred-1',
      rawId: buffer(bytes(1, 2)),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: buffer(bytes(0xaa)),
        authenticatorData: buffer(bytes(0xbb)),
        signature: buffer(bytes(0xcc)),
        userHandle: null,
      },
    } as unknown as PublicKeyCredential;

    const json: AuthenticationResponseJSON = toAuthenticationResponseJSON(credential);
    expect(json.id).toBe('cred-1');
    expect(json.rawId).toBe(encodeBase64url(bytes(1, 2)));
    expect(json.response.clientDataJSON).toBe(encodeBase64url(bytes(0xaa)));
    expect(json.response.authenticatorData).toBe(encodeBase64url(bytes(0xbb)));
    expect(json.response.signature).toBe(encodeBase64url(bytes(0xcc)));
    expect(json.response.userHandle).toBeUndefined();
  });

  test('registration 凭证缺可选 getter 时不报错', () => {
    const credential = {
      id: 'cred-2',
      rawId: buffer(bytes(3)),
      type: 'public-key',
      getClientExtensionResults: () => ({}),
      response: {
        clientDataJSON: buffer(bytes(1)),
        attestationObject: buffer(bytes(2)),
      },
    } as unknown as PublicKeyCredential;

    const json = toRegistrationResponseJSON(credential);
    expect(json.response.attestationObject).toBe(encodeBase64url(bytes(2)));
    expect(json.response.transports).toBeUndefined();
    expect(json.response.publicKey).toBeUndefined();
  });

  test('无 navigator.credentials 的环境判定为不可用', () => {
    expect(isWebAuthnAvailable()).toBe(false);
  });
});
