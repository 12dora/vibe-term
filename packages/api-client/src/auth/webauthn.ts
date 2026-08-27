// WebAuthn 薄适配层：把服务端下发的 *OptionsJSON 转成 `navigator.credentials` 需要的
// ArrayBuffer 形态，再把凭证转回 *ResponseJSON。等价于 @simplewebauthn/browser 的
// startRegistration / startAuthentication，但不引入依赖（仓库尚未安装该包）。

import { decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialDescriptorJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from './types';

export class WebAuthnError extends Error {
  constructor(
    readonly code: 'unsupported' | 'aborted' | 'failed',
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'WebAuthnError';
  }
}

function toBuffer(value: string): ArrayBuffer {
  const bytes = decodeBase64url(value);
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function fromBuffer(value: ArrayBuffer | null | undefined): string {
  if (!value) return '';
  return encodeBase64url(new Uint8Array(value));
}

function toDescriptors(
  list: PublicKeyCredentialDescriptorJSON[] | undefined
): PublicKeyCredentialDescriptor[] | undefined {
  if (!list?.length) return undefined;
  return list.map((item) => ({
    id: toBuffer(item.id),
    type: 'public-key',
    transports: item.transports as AuthenticatorTransport[] | undefined,
  }));
}

/** WebAuthn 是否在当前环境可用（`passkeyAvailable` 的前端侧兜底判断）。 */
export function isWebAuthnAvailable(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

export function toCreationOptions(
  json: PublicKeyCredentialCreationOptionsJSON
): PublicKeyCredentialCreationOptions {
  return {
    rp: { id: json.rp.id, name: json.rp.name },
    user: {
      id: toBuffer(json.user.id),
      name: json.user.name,
      displayName: json.user.displayName,
    },
    challenge: toBuffer(json.challenge),
    pubKeyCredParams: json.pubKeyCredParams.map((param) => ({
      alg: param.alg,
      type: 'public-key',
    })),
    timeout: json.timeout,
    excludeCredentials: toDescriptors(json.excludeCredentials),
    authenticatorSelection: json.authenticatorSelection as
      | AuthenticatorSelectionCriteria
      | undefined,
    attestation: json.attestation as AttestationConveyancePreference | undefined,
    extensions: json.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

export function toRequestOptions(
  json: PublicKeyCredentialRequestOptionsJSON
): PublicKeyCredentialRequestOptions {
  return {
    challenge: toBuffer(json.challenge),
    timeout: json.timeout,
    rpId: json.rpId,
    allowCredentials: toDescriptors(json.allowCredentials),
    userVerification: json.userVerification as UserVerificationRequirement | undefined,
    extensions: json.extensions as AuthenticationExtensionsClientInputs | undefined,
  };
}

export function toRegistrationResponseJSON(
  credential: PublicKeyCredential
): RegistrationResponseJSON {
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports =
    typeof response.getTransports === 'function' ? response.getTransports() : undefined;
  return {
    id: credential.id,
    rawId: fromBuffer(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
    response: {
      clientDataJSON: fromBuffer(response.clientDataJSON),
      attestationObject: fromBuffer(response.attestationObject),
      transports,
      publicKeyAlgorithm:
        typeof response.getPublicKeyAlgorithm === 'function'
          ? response.getPublicKeyAlgorithm()
          : undefined,
      publicKey:
        typeof response.getPublicKey === 'function'
          ? fromBuffer(response.getPublicKey())
          : undefined,
      authenticatorData:
        typeof response.getAuthenticatorData === 'function'
          ? fromBuffer(response.getAuthenticatorData())
          : undefined,
    },
  };
}

export function toAuthenticationResponseJSON(
  credential: PublicKeyCredential
): AuthenticationResponseJSON {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: fromBuffer(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults() as Record<string, unknown>,
    response: {
      clientDataJSON: fromBuffer(response.clientDataJSON),
      authenticatorData: fromBuffer(response.authenticatorData),
      signature: fromBuffer(response.signature),
      userHandle: response.userHandle ? fromBuffer(response.userHandle) : undefined,
    },
  };
}

function wrapCeremonyError(error: unknown): WebAuthnError {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new WebAuthnError('aborted', 'passkey ceremony aborted', error);
  }
  return new WebAuthnError('failed', (error as Error)?.message ?? 'passkey ceremony failed', error);
}

/** 注册仪式：等价 @simplewebauthn/browser `startRegistration({ optionsJSON })`。 */
export async function startRegistration(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
  signal?: AbortSignal
): Promise<RegistrationResponseJSON> {
  if (!isWebAuthnAvailable()) {
    throw new WebAuthnError('unsupported', 'WebAuthn is not available in this context');
  }
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: toCreationOptions(optionsJSON),
      signal,
    });
  } catch (error) {
    throw wrapCeremonyError(error);
  }
  if (!credential) {
    throw new WebAuthnError('failed', 'authenticator returned no credential');
  }
  return toRegistrationResponseJSON(credential as PublicKeyCredential);
}

/** 断言仪式：等价 @simplewebauthn/browser `startAuthentication({ optionsJSON })`。 */
export async function startAuthentication(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
  signal?: AbortSignal
): Promise<AuthenticationResponseJSON> {
  if (!isWebAuthnAvailable()) {
    throw new WebAuthnError('unsupported', 'WebAuthn is not available in this context');
  }
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: toRequestOptions(optionsJSON),
      signal,
    });
  } catch (error) {
    throw wrapCeremonyError(error);
  }
  if (!credential) {
    throw new WebAuthnError('failed', 'authenticator returned no assertion');
  }
  return toAuthenticationResponseJSON(credential as PublicKeyCredential);
}

/**
 * 对任意 challenge 做一次断言（用于给 `user_key_log` 记录签名：challenge = sha256(recordBytes)）。
 * 后端没有「按任意 challenge 下发 options」的端点，故 rpId 取当前 host、
 * 依赖 residentKey 的可发现凭证，由后端按返回的 credential_id 定位公钥。
 */
export async function assertForChallenge(
  challenge: Uint8Array,
  opts?: { rpId?: string; allowCredentials?: PublicKeyCredentialDescriptorJSON[] }
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({
    challenge: encodeBase64url(challenge),
    rpId: opts?.rpId ?? (typeof location !== 'undefined' ? location.hostname : undefined),
    allowCredentials: opts?.allowCredentials,
    userVerification: 'required',
  });
}
