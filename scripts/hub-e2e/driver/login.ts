#!/usr/bin/env bun
/**
 * 浏览器式密码登录：Argon2 seed → Ed25519 root → delegation → challenge/login。
 * 从仓库根运行：bun scripts/hub-e2e/driver/login.ts --base-url https://hub.tmex.test ...
 */
import {
  buildLogin,
  createDelegation,
  decodeBase64url,
  deriveSeed,
  encodeBase64url,
  encodeLogin,
  generateEd25519KeyPair,
  rootKeyFromSeed,
  signLogin,
} from '../../../packages/shared/src/auth/index.ts';
import {
  type CookieMap,
  type LoginState,
  apiFetch,
  cookieHeaderFromMap,
  parseArgs,
  requireArg,
} from './lib.ts';

interface AuthMode {
  mode?: string;
  nodeId?: string;
  uid?: string | null;
  username?: string | null;
  kdfParams?: {
    salt: string;
    memory_kib: number;
    iterations: number;
    parallelism: number;
  } | null;
  rootEpoch?: number | null;
  rootPublicKey?: string | null;
  hubPublicUrl?: string | null;
}

async function loginSelf(
  baseUrl: string,
  password: string
): Promise<{ state: LoginState; mode: AuthMode }> {
  const modeRes = await apiFetch(baseUrl, '/api/auth/mode');
  if (!modeRes.res.ok) {
    throw new Error(`GET /api/auth/mode ${modeRes.res.status}: ${modeRes.text}`);
  }
  const mode = modeRes.json as AuthMode;
  if (!mode.uid || !mode.kdfParams || !mode.nodeId) {
    throw new Error(`auth mode missing uid/kdfParams/nodeId: ${modeRes.text}`);
  }
  const seed = await deriveSeed(password, {
    salt: decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  });
  const rootKey = rootKeyFromSeed(seed);
  const sess = generateEd25519KeyPair();
  const del = createDelegation(rootKey, {
    uid: mode.uid,
    sessPk: sess.publicKey,
    now: Date.now(),
  });
  const ch = await apiFetch(baseUrl, '/api/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ uid: mode.uid }),
  });
  if (!ch.res.ok) {
    throw new Error(`POST /api/auth/challenge ${ch.res.status}: ${ch.text}`);
  }
  const challenge = ch.json as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: challenge.challenge_id,
    nonce: decodeBase64url(challenge.nonce),
    target: 'self',
    targetPk: decodeBase64url(challenge.nodePk),
    uid: mode.uid,
    entry: 'self',
  });
  const loginRes = await apiFetch(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
    }),
  });
  if (!loginRes.res.ok) {
    throw new Error(`POST /api/auth/login ${loginRes.res.status}: ${loginRes.text}`);
  }
  const cookies = loginRes.cookies;
  if (!cookies.tmex_s_self) {
    throw new Error(`login succeeded but no tmex_s_self cookie: ${loginRes.text}`);
  }
  return {
    mode,
    state: {
      cookies,
      cookieHeader: cookieHeaderFromMap(cookies),
      uid: mode.uid,
      nodeId: mode.nodeId,
      username: mode.username ?? null,
    },
  };
}

async function loginRemote(
  baseUrl: string,
  password: string,
  targetNodeId: string,
  cookies: CookieMap,
  uid: string,
  entryNodeId: string
): Promise<CookieMap> {
  const seedMode = await apiFetch(baseUrl, '/api/auth/mode', { cookies });
  const mode = seedMode.json as AuthMode;
  if (!mode.kdfParams) {
    throw new Error('remote login: missing kdfParams');
  }
  const seed = await deriveSeed(password, {
    salt: decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  });
  const rootKey = rootKeyFromSeed(seed);
  const sess = generateEd25519KeyPair();
  const del = createDelegation(rootKey, {
    uid,
    sessPk: sess.publicKey,
    now: Date.now(),
  });
  const ch = await apiFetch(baseUrl, `/n/${targetNodeId}/api/auth/challenge`, {
    method: 'POST',
    cookies,
    body: JSON.stringify({ uid }),
  });
  if (!ch.res.ok) {
    throw new Error(
      `POST /n/${targetNodeId}/api/auth/challenge ${ch.res.status}: ${ch.text}`
    );
  }
  const challenge = ch.json as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: challenge.challenge_id,
    nonce: decodeBase64url(challenge.nonce),
    target: targetNodeId,
    targetPk: decodeBase64url(challenge.nodePk),
    uid,
    entry: entryNodeId,
  });
  const loginRes = await apiFetch(baseUrl, `/n/${targetNodeId}/api/auth/login`, {
    method: 'POST',
    cookies,
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
    }),
  });
  if (!loginRes.res.ok) {
    throw new Error(`POST /n/${targetNodeId}/api/auth/login ${loginRes.res.status}: ${loginRes.text}`);
  }
  const cookieName = `tmex_s_${targetNodeId}`;
  if (!loginRes.cookies[cookieName]) {
    throw new Error(`remote login missing ${cookieName}: ${loginRes.text}`);
  }
  return loginRes.cookies;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = requireArg(args, 'base-url');
const password = requireArg(args, 'password');
const username = typeof args.username === 'string' ? args.username : 'alice';
const target = typeof args['target-node-id'] === 'string' ? args['target-node-id'] : '';
const outPath = typeof args.out === 'string' ? args.out : '';

const { state, mode } = await loginSelf(baseUrl, password);
if (mode.username && mode.username !== username) {
  throw new Error(`mode.username=${mode.username} !== ${username}`);
}

let cookies = state.cookies;
if (target) {
  cookies = await loginRemote(baseUrl, password, target, cookies, state.uid, state.nodeId);
}

const result: LoginState & { mode: AuthMode } = {
  cookies,
  cookieHeader: cookieHeaderFromMap(cookies),
  uid: state.uid,
  nodeId: state.nodeId,
  username: state.username,
  mode,
};
const encoded = `${JSON.stringify(result, null, 2)}\n`;
if (outPath) {
  await Bun.write(outPath, encoded);
}
process.stdout.write(encoded);
