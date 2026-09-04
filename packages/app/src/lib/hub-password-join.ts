import {
  ENROLLMENT_TTL_MS,
  type KdfParams,
  canonicalHubUrl,
  createEnrollment,
  decodeBase64url,
  encodeBase64url,
  encodeJoinToken,
  hubHostFromUrl,
  signHubEnrollProof,
} from '../../../shared/src/auth';
import {
  KdfParamsBudgetError,
  assertKdfParamsWithinBudget,
} from '../../../shared/src/auth/root-key';
import { JoinError } from '../commands/hub';
import { type HubFetch, assertHubJoinUrl, isNetworkFetchError } from './hub-client';
import { deriveRootKey } from './password';

export type RequestEnrollmentByPasswordInput = {
  hubUrl: string;
  password: string;
  fetcher?: HubFetch;
  insecureLocal?: boolean;
  nodeEnv?: string;
  now?: () => number;
};

export type EnrollmentByPasswordMaterial = {
  token: string;
  enrollmentId?: string;
  hubUrl: string;
  caFingerprint: string | null;
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function kdfFromMode(params: {
  salt: string;
  memory_kib: number;
  iterations: number;
  parallelism: number;
}): KdfParams {
  return {
    salt: decodeBase64url(params.salt),
    memory_kib: params.memory_kib,
    iterations: params.iterations,
    parallelism: params.parallelism,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function asKdf(raw: unknown): ReturnType<typeof kdfFromMode> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.salt !== 'string') return null;
  if (typeof obj.memory_kib !== 'number' || typeof obj.iterations !== 'number') return null;
  if (typeof obj.parallelism !== 'number') return null;
  return kdfFromMode({
    salt: obj.salt,
    memory_kib: obj.memory_kib,
    iterations: obj.iterations,
    parallelism: obj.parallelism,
  });
}

function hexFingerprint(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function mapJoinFetchError(error: unknown, fallback: string): JoinError {
  if (error instanceof JoinError) return error;
  return new JoinError(
    isNetworkFetchError(error) ? 'hub_unreachable' : 'join_failed',
    error instanceof Error ? error.message : fallback
  );
}

function canonicalJoinHubUrl(input: RequestEnrollmentByPasswordInput): string {
  try {
    return canonicalHubUrl(
      assertHubJoinUrl(
        input.hubUrl,
        input.insecureLocal === true,
        input.nodeEnv ?? process.env.NODE_ENV
      ).toString()
    );
  } catch (error) {
    throw new JoinError('invalid_url', error instanceof Error ? error.message : 'invalid hub url');
  }
}

async function fetchHubAuthMode(
  fetcher: HubFetch,
  hubUrl: string
): Promise<Record<string, unknown>> {
  try {
    const response = await fetcher(joinUrl(hubUrl, '/api/auth/mode'), { redirect: 'error' });
    const modeBody = await readJson(response);
    if (!response.ok) {
      throw new JoinError('join_failed', `auth mode failed: HTTP ${response.status}`);
    }
    return modeBody;
  } catch (error) {
    throw mapJoinFetchError(error, 'unable to resolve hub auth mode');
  }
}

function modeIdentity(modeBody: Record<string, unknown>): {
  uid: string;
  kdfParams: KdfParams;
  rootEpoch: number;
} {
  const uid = typeof modeBody.uid === 'string' ? modeBody.uid : null;
  const kdfParams = asKdf(modeBody.kdfParams);
  if (!uid || !kdfParams) {
    throw new JoinError('join_failed', 'unable to resolve hub uid and kdf params');
  }
  try {
    assertKdfParamsWithinBudget(kdfParams);
  } catch (error) {
    throw new JoinError(
      'join_failed',
      error instanceof KdfParamsBudgetError ? error.message : 'kdf params exceed client budget'
    );
  }
  const rootEpoch =
    typeof modeBody.rootEpoch === 'number' && Number.isFinite(modeBody.rootEpoch)
      ? modeBody.rootEpoch
      : 0;
  return { uid, kdfParams, rootEpoch };
}

async function postPasswordEnrollment(
  fetcher: HubFetch,
  hubUrl: string,
  enrollment: Awaited<ReturnType<typeof createEnrollment>>,
  signed: { bytes: Uint8Array; sig: Uint8Array },
  now: number
): Promise<Record<string, unknown>> {
  try {
    const response = await fetcher(joinUrl(hubUrl, '/api/hub/enrollments/by-password'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      body: JSON.stringify({
        proof: { bytes: encodeBase64url(signed.bytes), sig: encodeBase64url(signed.sig) },
        enroll_pk: encodeBase64url(enrollment.enrollPk),
        authorization: encodeBase64url(enrollment.authorizationBytes),
        authorization_sig: encodeBase64url(enrollment.authorizationSig),
        exp: now + ENROLLMENT_TTL_MS,
      }),
    });
    const created = await readJson(response);
    if (!response.ok) {
      const err = String(created.error ?? created.code ?? response.status);
      throw new JoinError(
        response.status >= 500 ? 'hub_unreachable' : 'join_failed',
        `password enrollment failed: ${err}`
      );
    }
    return created;
  } catch (error) {
    throw mapJoinFetchError(error, 'password enrollment failed');
  }
}

function wipeEnrollmentSecrets(
  rootKey: { seed: Uint8Array },
  enrollment: { enrollSk: Uint8Array }
): void {
  rootKey.seed.fill(0);
  enrollment.enrollSk.fill(0);
}

function joinTokenFromCreated(
  created: Record<string, unknown>,
  modeBody: Record<string, unknown>,
  enrollment: Awaited<ReturnType<typeof createEnrollment>>,
  rootKey: { publicKey: Uint8Array; seed: Uint8Array }
): { token: string; enrollmentId?: string; caFingerprint: string | null } {
  const headHashRaw = created.key_log_head_hash;
  const caFingerprint =
    hexFingerprint(created.ca_fingerprint) ?? hexFingerprint(modeBody.caFingerprint);
  if (typeof headHashRaw !== 'string') {
    wipeEnrollmentSecrets(rootKey, enrollment);
    throw new JoinError('join_failed', 'password enrollment missing key_log_head_hash');
  }
  let headHash: Uint8Array;
  try {
    headHash = decodeBase64url(headHashRaw);
  } catch {
    wipeEnrollmentSecrets(rootKey, enrollment);
    throw new JoinError('join_failed', 'password enrollment missing key_log_head_hash');
  }
  const token = encodeJoinToken(enrollment.enrollSk, rootKey.publicKey, headHash, caFingerprint);
  wipeEnrollmentSecrets(rootKey, enrollment);
  return {
    token,
    enrollmentId: typeof created.id === 'string' ? created.id : undefined,
    caFingerprint,
  };
}

export async function requestEnrollmentByPassword(
  input: RequestEnrollmentByPasswordInput
): Promise<EnrollmentByPasswordMaterial> {
  if (!input.password) {
    throw new JoinError('join_failed', 'password cannot be empty');
  }
  const hubUrl = canonicalJoinHubUrl(input);
  const fetcher = input.fetcher ?? fetch;
  const modeBody = await fetchHubAuthMode(fetcher, hubUrl);
  const { uid, kdfParams, rootEpoch } = modeIdentity(modeBody);
  const rootKey = await deriveRootKey(input.password, kdfParams);
  const now = input.now?.() ?? Date.now();
  const enrollment = await createEnrollment(rootKey, { uid, rootEpoch, now });
  const signed = signHubEnrollProof(rootKey, {
    hubHost: hubHostFromUrl(hubUrl),
    uid,
    enrollPk: enrollment.enrollPk,
    ts: now,
  });
  let created: Record<string, unknown>;
  try {
    created = await postPasswordEnrollment(fetcher, hubUrl, enrollment, signed, now);
  } catch (error) {
    wipeEnrollmentSecrets(rootKey, enrollment);
    throw error;
  }
  const material = joinTokenFromCreated(created, modeBody, enrollment, rootKey);
  return { ...material, hubUrl };
}

export async function resolveHubJoinToken(input: {
  token?: string;
  password?: string | boolean;
  hubUrl: string;
  fetcher?: HubFetch;
  insecureLocal?: boolean;
  nodeEnv?: string;
  now?: () => number;
  resolvePassword: (password?: string) => Promise<string>;
}): Promise<string> {
  const hasToken = Boolean(input.token);
  const hasPassword = input.password !== undefined && input.password !== false;
  if (hasToken && hasPassword) {
    throw new Error('hub join --token and --password are mutually exclusive');
  }
  if (hasToken && input.token) return input.token;
  if (!hasPassword) {
    throw new Error('hub join requires --token or --password');
  }
  const password = await input.resolvePassword(
    typeof input.password === 'string' ? input.password : undefined
  );
  const material = await requestEnrollmentByPassword({
    hubUrl: input.hubUrl,
    password,
    fetcher: input.fetcher,
    insecureLocal: input.insecureLocal,
    nodeEnv: input.nodeEnv,
    now: input.now,
  });
  return material.token;
}
