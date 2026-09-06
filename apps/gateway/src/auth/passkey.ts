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
import type { AddPasskeyPayload, Delegation, VerifyPasskeyAssertion } from '@vibeterm/shared/auth';
import type { VerifyDelegationPasskey } from '@vibeterm/shared/auth';
import {
  decodeBase64url,
  decodePasskeyAssertion,
  encodeBase64url,
  encodePasskeyAssertion,
  verifyDelegationTimes,
} from '@vibeterm/shared/auth';
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

export type MakeVerifyDelegationPasskeyOptions = {
  now?: () => number;
};

export function encodePasskeyAssertionSig(assertion: AuthenticationResponseJSON): Uint8Array {
  return encodePasskeyAssertion({
    credential_id: assertion.id,
    client_data_json: decodeBase64url(assertion.response.clientDataJSON),
    authenticator_data: decodeBase64url(assertion.response.authenticatorData),
    signature: decodeBase64url(assertion.response.signature),
  });
}

export function decodePasskeyAssertionSig(sig: Uint8Array): AuthenticationResponseJSON {
  const decoded = decodePasskeyAssertion(sig);
  const id = decoded.credential_id;
  return {
    id,
    rawId: id,
    type: 'public-key',
    response: {
      clientDataJSON: encodeBase64url(decoded.client_data_json),
      authenticatorData: encodeBase64url(decoded.authenticator_data),
      signature: encodeBase64url(decoded.signature),
    },
    clientExtensionResults: {},
  };
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
    origin: input.origin,
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

/** 一次验签得出的计数器推进；落库时机由调用方决定。 */
export type PasskeyCounterUpdate = { credentialId: Uint8Array; counter: number };

/**
 * 验签本身（不写计数器）。计数器只能推进一次：预演验签写了，随后真正落账的那次验签
 * 就会因为「新计数器不大于已存计数器」而失败——计数器会自增的认证器上必然踩到。
 */
async function verifyStoredAssertion(
  userStore: UserStore,
  args: { sig: Uint8Array; credentialId: string; publicKey: Uint8Array; challenge: Uint8Array }
): Promise<PasskeyCounterUpdate | null> {
  let assertion: AuthenticationResponseJSON;
  try {
    assertion = decodePasskeyAssertionSig(args.sig);
  } catch {
    return null;
  }
  const credentialIdBytes = decodeBase64url(args.credentialId);
  const stored = userStore.getKeyByCredentialId(credentialIdBytes);
  if (!stored) {
    return null;
  }
  const result = await verifyAssertion({
    response: assertion,
    expectedChallenge: encodeBase64url(args.challenge),
    origin: stored.origin,
    rpId: stored.rpId,
    credential: {
      id: args.credentialId,
      publicKey: args.publicKey,
      counter: stored.counter,
      transports: stored.transports,
    },
  });
  if (!result.ok) {
    return null;
  }
  return { credentialId: credentialIdBytes, counter: result.newCounter };
}

export function commitPasskeyCounters(
  userStore: UserStore,
  updates: readonly PasskeyCounterUpdate[]
): void {
  for (const update of updates) userStore.updateKeyCounter(update.credentialId, update.counter);
}

/** 验签并立刻推进计数器：一次性场景（登录、中继接入）用。 */
export function makeVerifyPasskeyAssertion(userStore: UserStore): VerifyPasskeyAssertion {
  return async (args) => {
    const update = await verifyStoredAssertion(userStore, args);
    if (!update) return false;
    userStore.updateKeyCounter(update.credentialId, update.counter);
    return true;
  };
}

export type DeferredPasskeyVerification = {
  verify: VerifyPasskeyAssertion;
  /** 本次验签累积的计数器推进；记录真正落库时（同一事务内）才写，被拒就整份丢掉。 */
  counters(): readonly PasskeyCounterUpdate[];
};

/**
 * 验签但不写计数器。同一条记录会被验多次（`hub=sync` 先预演、hub 确认后再本地落账，
 * 落账内部又要验一次 authorization），写计数器必须只发生一次、且与记录落库同一个事务。
 */
export function makeDeferredVerifyPasskeyAssertion(
  userStore: UserStore
): DeferredPasskeyVerification {
  const pending = new Map<string, PasskeyCounterUpdate>();
  return {
    verify: async (args) => {
      const update = await verifyStoredAssertion(userStore, args);
      if (!update) return false;
      const existing = pending.get(args.credentialId);
      if (!existing || update.counter > existing.counter) pending.set(args.credentialId, update);
      return true;
    },
    counters: () => [...pending.values()],
  };
}

export function makeVerifyDelegationPasskey(
  userStore: UserStore,
  options?: MakeVerifyDelegationPasskeyOptions
): VerifyDelegationPasskey {
  const now = options?.now ?? (() => Date.now());
  return async ({
    challenge,
    assertion,
    credentialId,
    delegation,
  }: {
    challenge: Uint8Array;
    delegation: Delegation;
    assertion: unknown;
    credentialId: string;
  }) => {
    if (!verifyDelegationTimes(delegation, now()).ok) {
      return false;
    }
    const stored = userStore.getKeyByCredentialId(decodeBase64url(credentialId));
    if (!stored || stored.userId !== delegation.uid) {
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
