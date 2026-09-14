import {
  buildLogin,
  createDelegation,
  decodeBase64url,
  encodeBase64url,
  encodeLogin,
  generateEd25519KeyPair,
  signLogin,
} from '@vibeterm/shared/auth';
import { nodeSessionCookieName } from '../../auth';
import type { AuthDb } from '../../auth/types';
import type { GatewayRuntime } from '../../runtime';
import type { WebSocketServer } from '../../ws';
import { MESH_VIA_SELF, setMeshRequestContext } from '../mesh-deps';
import type { MeshRuntime } from '../mesh-runtime';

export const dummyServer = { upgrade: () => false };

export type BootUser = {
  userId: string;
  rootKey: Parameters<typeof createDelegation>[0];
  rootPublicKey: Uint8Array;
  rootEpoch: number;
};

export function fakeGateway(db: AuthDb, label: string): GatewayRuntime {
  return {
    port: 0,
    db,
    wsServer: {} as WebSocketServer,
    handleRequest: () => undefined,
    dispatchHttp: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/system/info') {
        return new Response(JSON.stringify({ version: 'test', node: label }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/api/devices') {
        return new Response(JSON.stringify({ devices: [{ id: `dev-${label}` }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404 });
    },
    websocket: {
      backpressureLimit: 1024,
      closeOnBackpressureLimit: true,
      open() {},
      message() {},
      drain() {},
      close() {},
      closeSession() {},
    },
    onRestartRequested() {},
    stop: async () => {},
  };
}

export function sidFromResponse(res: Response, nodeId = MESH_VIA_SELF): string {
  const cookies = res.headers.getSetCookie?.() ?? [];
  const prefix = `${nodeSessionCookieName(nodeId)}=`;
  for (const cookie of cookies) {
    if (cookie.startsWith(prefix)) {
      return cookie.slice(prefix.length).split(';')[0] ?? '';
    }
  }
  const header = res.headers.get('set-cookie') ?? '';
  const match = header.match(new RegExp(`${nodeSessionCookieName(nodeId)}=([^;]*)`));
  if (match?.[1]) return match[1];
  throw new Error(`no session cookie for ${nodeId}: ${header}`);
}

export async function callMesh(
  mesh: MeshRuntime,
  url: string,
  init?: RequestInit & { cookie?: string }
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.cookie) headers.set('cookie', init.cookie);
  const req = new Request(url, { ...init, headers });
  setMeshRequestContext(req, { via: MESH_VIA_SELF, clientIp: '127.0.0.1' });
  const res = await mesh.handleRequest(req, dummyServer);
  if (!(res instanceof Response)) {
    throw new Error(`unhandled ${url}`);
  }
  return res;
}

export async function loginSelf(mesh: MeshRuntime, boot: BootUser): Promise<string> {
  const sess = generateEd25519KeyPair();
  const now = Date.now();
  const del = createDelegation(boot.rootKey, {
    uid: boot.userId,
    sessPk: sess.publicKey,
    now,
  });
  const ch = await callMesh(mesh, 'http://entry/api/auth/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: boot.userId }),
  });
  if (ch.status !== 200) {
    throw new Error(`challenge ${ch.status}: ${await ch.text()}`);
  }
  const body = (await ch.json()) as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: mesh.nodeId,
    targetPk: decodeBase64url(body.nodePk),
    uid: boot.userId,
    entry: MESH_VIA_SELF,
  });
  const res = await callMesh(mesh, 'http://entry/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
    }),
  });
  if (res.status !== 200) {
    throw new Error(`login ${res.status}: ${await res.text()}`);
  }
  return sidFromResponse(res, MESH_VIA_SELF);
}

export async function loginRemote(
  entry: MeshRuntime,
  target: MeshRuntime,
  boot: BootUser,
  cookie: string
): Promise<Response> {
  const sess = generateEd25519KeyPair();
  const now = Date.now();
  const del = createDelegation(boot.rootKey, {
    uid: boot.userId,
    sessPk: sess.publicKey,
    now,
  });
  const ch = await callMesh(entry, `http://entry/n/${target.nodeId}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cookie,
    body: JSON.stringify({ uid: boot.userId }),
  });
  if (ch.status !== 200) return ch;
  const body = (await ch.json()) as { challenge_id: string; nonce: string; nodePk: string };
  const login = buildLogin({
    challengeId: body.challenge_id,
    nonce: decodeBase64url(body.nonce),
    target: target.nodeId,
    targetPk: decodeBase64url(body.nodePk),
    uid: boot.userId,
    entry: entry.nodeId,
  });
  return callMesh(entry, `http://entry/n/${target.nodeId}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cookie,
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(del.bytes),
      delegation_sig: encodeBase64url(del.sig),
    }),
  });
}

export function selfCookie(sid: string): string {
  return `${nodeSessionCookieName(MESH_VIA_SELF)}=${sid}`;
}

export function jarFor(selfSid: string, nodeId: string, nodeSid: string): string {
  return `${selfCookie(selfSid)}; ${nodeSessionCookieName(nodeId)}=${nodeSid}`;
}
