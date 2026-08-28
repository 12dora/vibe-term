#!/usr/bin/env bun
/**
 * 用根钥签 revoke-node，POST /api/auth/keylog?hub=sync。
 * 从仓库根：bun scripts/hub-e2e/split/revoke.ts --base-url … --cookie-file … --node-id … --password …
 */
import {
  buildKeyLogRecord,
  decodeBase64url,
  deriveSeed,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeRevokeNodePayload,
  hexToBytes,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
} from '../../../packages/shared/src/auth/index.ts';
import { apiFetch, loadLoginState, parseArgs, requireArg } from '../driver/lib.ts';

interface AuthMode {
  uid?: string | null;
  kdfParams?: {
    salt: string;
    memory_kib: number;
    iterations: number;
    parallelism: number;
  } | null;
  rootEpoch?: number | null;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = requireArg(args, 'base-url');
const password = requireArg(args, 'password');
const nodeId = requireArg(args, 'node-id');
const cookies = (await loadLoginState(requireArg(args, 'cookie-file'))).cookies;
const reason = typeof args.reason === 'string' ? args.reason : 'e2e-split-G';

const modeRes = await apiFetch(baseUrl, '/api/auth/mode', { cookies });
if (!modeRes.res.ok) {
  throw new Error(`GET /api/auth/mode ${modeRes.res.status}: ${modeRes.text}`);
}
const mode = modeRes.json as AuthMode;
if (!mode.uid || !mode.kdfParams || mode.rootEpoch == null) {
  throw new Error(`auth mode missing uid/kdf/rootEpoch: ${modeRes.text}`);
}

const headRes = await apiFetch(baseUrl, '/api/auth/keylog/head', { cookies });
if (!headRes.res.ok) {
  throw new Error(`GET /api/auth/keylog/head ${headRes.res.status}: ${headRes.text}`);
}
const head = headRes.json as { seq: number | string; hash: string; rootEpoch: number };
const seed = await deriveSeed(password, {
  salt: decodeBase64url(mode.kdfParams.salt),
  memory_kib: mode.kdfParams.memory_kib,
  iterations: mode.kdfParams.iterations,
  parallelism: mode.kdfParams.parallelism,
});
const rootKey = rootKeyFromSeed(seed);
const rec = buildKeyLogRecord(
  { seq: BigInt(head.seq), hash: decodeBase64url(head.hash) },
  head.rootEpoch ?? mode.rootEpoch,
  {
    uid: mode.uid,
    type: 'revoke-node',
    payload: encodeRevokeNodePayload({
      node_id: hexToBytes(nodeId),
      reason,
    }),
    signer: 'root',
    credential_id: null,
  }
);
const bytes = encodeKeyLogRecord(rec);
const sig = signKeyLogRecordWithRoot(rootKey, bytes);
rootKey.seed.fill(0);
seed.fill(0);

const posted = await apiFetch(baseUrl, '/api/auth/keylog?hub=sync', {
  method: 'POST',
  cookies,
  body: JSON.stringify({
    bytes: encodeBase64url(bytes),
    sig: encodeBase64url(sig),
  }),
});
process.stdout.write(
  `${JSON.stringify({ status: posted.res.status, ok: posted.res.ok, json: posted.json, text: posted.text }, null, 2)}\n`
);
if (!posted.res.ok) process.exit(1);
const body = posted.json as { ok?: boolean; hubAck?: boolean; code?: string };
if (body.ok !== true || body.hubAck !== true) {
  process.stderr.write(`revoke not acked: ${posted.text}\n`);
  process.exit(1);
}
