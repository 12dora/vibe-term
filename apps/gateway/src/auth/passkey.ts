import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { AddPasskeyPayload, Delegation, VerifyPasskeyAssertion } from '@tmex/shared/auth';
import type { VerifyDelegationPasskey } from '@tmex/shared/auth';
import { decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
import type { UserStore } from './user-store';

export type CreateRegistrationOptionsInput = {
  uid: string;
  userId: string;
  rpId: string;
  existingCredentialIds: string[];
  challenge: Uint8Array;
};

export type VerifyRegistrationInput = {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  origin: string;
  rpId: string;
};

export type CreateAuthenticationOptionsInput = {
  rpId: string;
  allowCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>;
  challenge: Uint8Array;
};

export type VerifyAssertionCredential = {
  id: string;
  publicKey: Uint8Array;
  counter: number;
  transports?: string[];
};

export type VerifyAssertionInput = {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  origin: string;
  rpId: string;
  credential: VerifyAssertionCredential;
};

export type VerifyAssertionResult =
  | { ok: true; newCounter: number; userVerified: boolean }
  | { ok: false };

/**
 * Passkey-signed key-log `sig` encoding:
 * UTF-8 bytes of `JSON.stringify(AuthenticationResponseJSON)`.
 * Challenge for that assertion is `sha256(recordBytes)` (base64url in clientDataJSON).
 */
export function encodePasskeyAssertionSig(assertion: AuthenticationResponseJSON): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(assertion));
}

export function decodePasskeyAssertionSig(sig: Uint8Array): AuthenticationResponseJSON {
  return JSON.parse(new TextDecoder().decode(sig)) as AuthenticationResponseJSON;
}

export async function createRegistrationOptions(
  input: CreateRegistrationOptionsInput
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: 'tmex',
    rpID: input.rpId,
    userName: input.uid,
    userID: Uint8Array.from(new TextEncoder().encode(input.userId)),
    challenge: input.challenge.slice(),
    attestationType: 'none',
    excludeCredentials: input.existingCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      userVerification: 'required',
      residentKey: 'preferred',
    },
  });
}

export async function verifyRegistration(
  input: VerifyRegistrationInput
): Promise<AddPasskeyPayload | null> {
  const verified = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: input.origin,
    expectedRPID: input.rpId,
    requireUserVerification: true,
  });
  if (!verified.verified) {
    return null;
  }
  const info = verified.registrationInfo;
  return {
    credential_id: info.credential.id,
    public_key: new Uint8Array(info.credential.publicKey),
    rp_id: info.rpID ?? input.rpId,
    origin: info.origin,
    counter: info.credential.counter,
    transports: info.credential.transports ?? [],
    backup_eligible: info.credentialDeviceType === 'multiDevice',
    backup_state: info.credentialBackedUp,
    device_type: info.credentialDeviceType,
    name: '',
  };
}

export async function createAuthenticationOptions(
  input: CreateAuthenticationOptionsInput
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: input.rpId,
    allowCredentials: input.allowCredentials,
    challenge: input.challenge.slice(),
    userVerification: 'required',
  });
}

export async function verifyAssertion(input: VerifyAssertionInput): Promise<VerifyAssertionResult> {
  try {
    const verified = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.origin,
      expectedRPID: input.rpId,
      credential: {
        id: input.credential.id,
        publicKey: input.credential.publicKey.slice(),
        counter: input.credential.counter,
        transports: input.credential.transports as AuthenticatorTransportFuture[] | undefined,
      },
      requireUserVerification: true,
    });
    if (!verified.verified) {
      return { ok: false };
    }
    const { newCounter, userVerified } = verified.authenticationInfo;
    if (input.credential.counter !== 0 && newCounter <= input.credential.counter) {
      return { ok: false };
    }
    return { ok: true, newCounter, userVerified };
  } catch {
    return { ok: false };
  }
}

export function makeVerifyPasskeyAssertion(userStore: UserStore): VerifyPasskeyAssertion {
  return async ({ sig, credentialId, publicKey, challenge }) => {
    let assertion: AuthenticationResponseJSON;
    try {
      assertion = decodePasskeyAssertionSig(sig);
    } catch {
      return false;
    }
    const credentialIdBytes = decodeBase64url(credentialId);
    const stored = userStore.getKeyByCredentialId(credentialIdBytes);
    if (!stored) {
      return false;
    }
    const result = await verifyAssertion({
      response: assertion,
      expectedChallenge: encodeBase64url(challenge),
      origin: stored.origin,
      rpId: stored.rpId,
      credential: {
        id: credentialId,
        publicKey,
        counter: stored.counter,
        transports: stored.transports,
      },
    });
    if (!result.ok) {
      return false;
    }
    userStore.updateKeyCounter(credentialIdBytes, result.newCounter);
    return true;
  };
}

export function makeVerifyDelegationPasskey(userStore: UserStore): VerifyDelegationPasskey {
  return async ({
    challenge,
    assertion,
    credentialId,
  }: {
    challenge: Uint8Array;
    delegation: Delegation;
    assertion: unknown;
    credentialId: string;
  }) => {
    const stored = userStore.getKeyByCredentialId(decodeBase64url(credentialId));
    if (!stored) {
      return false;
    }
    const result = await verifyAssertion({
      response: assertion as AuthenticationResponseJSON,
      expectedChallenge: encodeBase64url(challenge),
      origin: stored.origin,
      rpId: stored.rpId,
      credential: {
        id: credentialId,
        publicKey: stored.publicKey,
        counter: stored.counter,
        transports: stored.transports,
      },
    });
    if (!result.ok) {
      return false;
    }
    userStore.updateKeyCounter(stored.credentialId, result.newCounter);
    return true;
  };
}
