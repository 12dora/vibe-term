#!/usr/bin/env bun
// relay e2e 的进程主管：从源码拉起三个 VibeTerm runtime——
//   R = `relay,node`（公共中继 + 本机 node）
//   A = `node`（无 hub），用 `vibeterm relay enroll` 在 R 上开租户，成为该租户的主节点
//   B = `standalone`，用 A 生成的 `r3.` 加入码经 `vibeterm hub join --token` 并入同一租户
// 然后把连接信息（端口、节点编号、租户编号、管理令牌、可直接给 curl 用的 Cookie 头）
// 写进 state JSON。收到 SIGTERM/SIGINT 时回收全部子进程、tmux socket 与临时目录。
//
// 用法：
//   bun apps/fe/tests/helpers/relay-boot.ts --state /tmp/vibeterm-relay-e2e-<pid>.json
//   bun apps/fe/tests/helpers/relay-boot.ts --mode hub          # 只打印 hub 拓扑怎么起
//
// hub 拓扑（hub,node + node）不在本文件范围内，用既有的 mesh-boot.ts，别在这里复制一份。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { resolve } from 'node:path';
import { encodeBase64url } from '../../../../packages/shared/src/auth/index.ts';
import { parseEnvFile } from '../../../../packages/shared/src/env/load-env.ts';
import {
  type PendingRelayJoin,
  type Session,
  admitRelayNode,
  apiGet,
  cookieHeader,
  loginNode,
  mintRelayJoinToken,
  openSession,
} from './relay-boot-auth.ts';
import { buildState, hubModeHelp } from './relay-boot-state.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_AUTH = resolve(REPO_ROOT, 'packages/app/src/cli-auth-entry.ts');
const RUNTIME_SERVER = resolve(REPO_ROOT, 'packages/app/src/runtime/server.ts');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'apps/gateway/drizzle');
const FE_DIST_DIR = resolve(REPO_ROOT, 'apps/fe/dist');

const TMUX_SOCKETS = {
  relay: 'vibeterm-relay-e2e-r',
  a: 'vibeterm-relay-e2e-a',
  b: 'vibeterm-relay-e2e-b',
} as const;
const USERNAME = 'alice';
const RELAY_USERNAME = 'relayop';
const NODE_B_NAME = 'relay-node-b';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function log(message: string): void {
  process.stdout.write(`[relay-boot] ${message}\n`);
}

function canBind(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = net.createServer();
    server.once('error', () => done(false));
    server.once('listening', () => server.close(() => done(true)));
    server.listen(port, '127.0.0.1');
  });
}

function isListening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (value: boolean): void => {
      socket.destroy();
      done(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 200; port += 1) {
    if (!(await isListening(port)) && (await canBind(port))) return port;
  }
  throw new Error(`no free port from ${start}`);
}

function randomSecret(prefix: string): string {
  return `${prefix}${encodeBase64url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

function testMasterKey(): string {
  const key = parseEnvFile(
    readFileSync(resolve(REPO_ROOT, 'env', 'test.env'), 'utf8')
  ).VIBETERM_MASTER_KEY;
  if (!key) throw new Error('VIBETERM_MASTER_KEY missing from test.env');
  return key;
}

interface InstanceSpec {
  dir: string;
  roles: string;
  port: number;
  peerPort: number;
  tmuxSocket: string;
  relayPublicUrl?: string;
  relayAdminToken?: string;
}

function renderAppEnv(spec: InstanceSpec, masterKey: string): string {
  const lines = [
    'NODE_ENV=test',
    `VIBETERM_ROLES=${spec.roles}`,
    `VIBETERM_MASTER_KEY=${masterKey}`,
    `GATEWAY_PORT=${spec.port}`,
    'VIBETERM_BIND_HOST=127.0.0.1',
    `DATABASE_URL=${spec.dir}/vibeterm.db`,
    `VIBETERM_BASE_URL=http://127.0.0.1:${spec.port}`,
    // 中继模式下上级不再是 hub：两个键都必须为空，否则 uplink 会去拨不存在的 hub。
    'VIBETERM_HUB_URL=',
    'VIBETERM_HUB_PUBLIC_URL=',
    `VIBETERM_PEER_PORT=${spec.peerPort}`,
    'VIBETERM_PEER_BIND_HOST=127.0.0.1',
    'VIBETERM_STUN_SERVERS=',
    'VIBETERM_TRUST_PROXY=true',
    `VIBETERM_TMUX_SOCKET=${spec.tmuxSocket}`,
    'VIBETERM_SITE_NAME=VibeTerm',
  ];
  if (spec.relayPublicUrl) lines.push(`VIBETERM_RELAY_PUBLIC_URL=${spec.relayPublicUrl}`);
  if (spec.relayAdminToken) lines.push(`VIBETERM_RELAY_ADMIN_TOKEN=${spec.relayAdminToken}`);
  return `${lines.join('\n')}\n`;
}

const children = new Set<Bun.Subprocess>();

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'test',
    VIBETERM_MIGRATIONS_DIR: MIGRATIONS_DIR,
    ...extra,
  };
}

async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI_AUTH, ...args], {
    cwd: REPO_ROOT,
    env: cliEnv(extraEnv),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`cli ${args.join(' ')} exited ${code}\n${out}\n${err}`);
  return out;
}

async function readAppEnv(dir: string): Promise<Record<string, string>> {
  return parseEnvFile(await Bun.file(`${dir}/app.env`).text());
}

async function startInstance(dir: string): Promise<Bun.Subprocess> {
  const env = await readAppEnv(dir);
  const proc = Bun.spawn([process.execPath, RUNTIME_SERVER], {
    cwd: REPO_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      ...env,
      NODE_ENV: 'test',
      VIBETERM_MIGRATIONS_DIR: MIGRATIONS_DIR,
      VIBETERM_FE_DIST_DIR: FE_DIST_DIR,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.add(proc);
  return proc;
}

async function waitUntil(
  label: string,
  probe: () => Promise<boolean>,
  timeoutMs = 60_000,
  intervalMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
      last = 'not ready';
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`${label} timed out: ${last}`);
}

async function waitHealthy(port: number): Promise<void> {
  await waitUntil(`gateway ${port} healthz`, async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    return res.ok;
  });
}

interface RelayStatus {
  mode: 'relay' | 'hub' | 'none';
  tenantId: string | null;
  relays: Array<{ url: string; online: boolean; attached: boolean; lastError: string | null }>;
  metaEpoch: number;
  nodesViaRelay: number;
}

interface MeshNodeRow {
  id: string;
  name: string;
  online: boolean;
  transport: 'ws-secure' | 'relay' | 'dc' | null;
}

function ensureFeDist(): void {
  if (existsSync(`${FE_DIST_DIR}/index.html`) && process.env.VIBETERM_RELAY_E2E_BUILD_FE !== '1') {
    return;
  }
  log('building apps/fe (dist missing or VIBETERM_RELAY_E2E_BUILD_FE=1)');
  const result = spawnSync('bun', ['run', '--filter', '@vibeterm/fe', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('apps/fe build failed');
}

function killTmuxSocket(socket: string): void {
  // socket 名固定为 relay e2e 专用，绝不会命中默认 socket / 生产 VibeTerm session。
  spawnSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
}

let cleanedUp = false;
let tmpDirRef: string | null = null;
function cleanup(tmpDir: string | null = tmpDirRef): void {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  for (const socket of Object.values(TMUX_SOCKETS)) killTmuxSocket(socket);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

function printHubMode(): void {
  process.stdout.write(hubModeHelp());
}

interface Ports {
  relay: number;
  a: number;
  b: number;
  relayPeer: number;
  aPeer: number;
  bPeer: number;
}

async function allocatePorts(): Promise<Ports> {
  const relay = await findFreePort(19851);
  const a = await findFreePort(relay + 1);
  const b = await findFreePort(a + 1);
  const relayPeer = await findFreePort(39851);
  const aPeer = await findFreePort(relayPeer + 1);
  const bPeer = await findFreePort(aPeer + 1);
  return { relay, a, b, relayPeer, aPeer, bPeer };
}

async function writeEnvFiles(
  dirs: { relay: string; a: string; b: string },
  ports: Ports,
  relay: { publicUrl: string; adminToken: string }
): Promise<void> {
  const masterKey = testMasterKey();
  await Bun.write(
    `${dirs.relay}/app.env`,
    renderAppEnv(
      {
        dir: dirs.relay,
        roles: 'relay,node',
        port: ports.relay,
        peerPort: ports.relayPeer,
        tmuxSocket: TMUX_SOCKETS.relay,
        relayPublicUrl: relay.publicUrl,
        relayAdminToken: relay.adminToken,
      },
      masterKey
    )
  );
  await Bun.write(
    `${dirs.a}/app.env`,
    renderAppEnv(
      {
        dir: dirs.a,
        roles: 'node',
        port: ports.a,
        peerPort: ports.aPeer,
        tmuxSocket: TMUX_SOCKETS.a,
      },
      masterKey
    )
  );
  await Bun.write(
    `${dirs.b}/app.env`,
    renderAppEnv(
      {
        dir: dirs.b,
        roles: 'standalone',
        port: ports.b,
        peerPort: ports.bPeer,
        tmuxSocket: TMUX_SOCKETS.b,
      },
      masterKey
    )
  );
}

async function setRelayPassword(
  publicUrl: string,
  adminToken: string,
  password: string
): Promise<void> {
  const res = await fetch(`${publicUrl}/api/relay/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ password, mode: 'keep' }),
  });
  if (!res.ok) throw new Error(`relay password ${res.status}: ${await res.text()}`);
}

async function enrollTenant(input: {
  aDir: string;
  publicUrl: string;
  relayPassword: string;
  meshPassword: string;
}): Promise<void> {
  await runCli(
    [
      'relay',
      'enroll',
      input.publicUrl,
      '--password',
      input.relayPassword,
      '--install-dir',
      input.aDir,
    ],
    { VIBETERM_PASSWORD: input.meshPassword }
  );
}

async function waitTenantAttached(session: Session, publicUrl: string): Promise<RelayStatus> {
  let snapshot: RelayStatus | null = null;
  await waitUntil('relay tenant attached', async () => {
    const status = await apiGet<RelayStatus>(session, '/api/mesh/relay/status', 'relay status');
    snapshot = status;
    return (
      status.mode === 'relay' &&
      status.relays.some((row) => row.url === publicUrl && row.online && row.attached)
    );
  });
  if (!snapshot) throw new Error('relay status never read');
  return snapshot;
}

async function joinNodeB(input: {
  bDir: string;
  session: Session;
  meshPassword: string;
}): Promise<{ pending: PendingRelayJoin; nodeId: string }> {
  const pending = await mintRelayJoinToken(input.session);
  log(`r3 join token minted (len=${pending.token.length})`);
  await runCli(
    [
      'hub',
      'join',
      '--token',
      pending.token,
      '--name',
      NODE_B_NAME,
      '--no-restart',
      '--install-dir',
      input.bDir,
    ],
    { VIBETERM_PASSWORD: input.meshPassword }
  );
  log('node B redeemed the join token');
  const nodeId = await admitRelayNode(input.session, pending);
  log(`node B admitted id=${nodeId}`);
  return { pending, nodeId };
}

async function readMeshNodes(session: Session): Promise<MeshNodeRow[]> {
  const body = await apiGet<{ nodes?: MeshNodeRow[] }>(session, '/api/mesh/nodes', 'mesh nodes');
  return body.nodes ?? [];
}

async function waitNodeOnline(session: Session, name: string): Promise<MeshNodeRow> {
  let row: MeshNodeRow | undefined;
  await waitUntil(
    `node ${name} online`,
    async () => {
      row = (await readMeshNodes(session)).find((node) => node.name === name);
      return Boolean(row?.online);
    },
    120_000,
    1000
  );
  if (!row) throw new Error(`node ${name} never listed`);
  return row;
}

/** 打一次 `/n/<id>` 代理：既验证转发链路，也逼出对端链路——不建流时 `transport` 一直是 null。 */
async function probeViaEntry(session: Session, nodeId: string): Promise<void> {
  await waitUntil(
    `proxy /n/${nodeId}`,
    async () => {
      const res = await fetch(`${session.baseUrl}/n/${nodeId}/api/system/info`, {
        headers: { cookie: cookieHeader(session.cookies) },
      });
      if (res.status === 200) return true;
      throw new Error(`status ${res.status}: ${(await res.text()).slice(0, 200)}`);
    },
    60_000,
    1000
  );
}

/** 中继链路一律先记 `relay`，直连打通后才升级成 `dc` / `ws-secure`；等不到也不算失败。 */
async function waitTransport(session: Session, nodeId: string): Promise<MeshNodeRow> {
  let row: MeshNodeRow | undefined;
  await waitUntil(
    `node ${nodeId} transport`,
    async () => {
      row = (await readMeshNodes(session)).find((node) => node.id === nodeId);
      return Boolean(row?.transport);
    },
    30_000,
    1000
  ).catch(() => undefined);
  if (!row) throw new Error(`node ${nodeId} vanished from the node list`);
  return row;
}

async function main(): Promise<void> {
  if (arg('mode') === 'hub') {
    printHubMode();
    return;
  }
  const statePath = arg('state');
  if (!statePath) throw new Error('missing --state <path>');

  ensureFeDist();

  const tmpDir = `/tmp/vibeterm-relay-e2e-${process.pid}-${Date.now()}`;
  tmpDirRef = tmpDir;
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  const dirs = { relay: `${tmpDir}/relay`, a: `${tmpDir}/a`, b: `${tmpDir}/b` };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

  const ports = await allocatePorts();
  const publicUrl = `http://127.0.0.1:${ports.relay}`;
  const adminToken = encodeBase64url(crypto.getRandomValues(new Uint8Array(32)));
  const meshPassword = randomSecret('VibeTermRelayE2e!');
  const relayNodePassword = randomSecret('VibeTermRelayOps!');
  const relayPassword = randomSecret('VibeTermRelayPw!');
  await writeEnvFiles(dirs, ports, { publicUrl, adminToken });
  for (const socket of Object.values(TMUX_SOCKETS)) killTmuxSocket(socket);
  log(`relay=${ports.relay} a=${ports.a} b=${ports.b} tmp=${tmpDir}`);

  await runCli(['hub', 'user', 'add', RELAY_USERNAME, '--install-dir', dirs.relay], {
    VIBETERM_PASSWORD: relayNodePassword,
  });
  await runCli(['hub', 'user', 'add', USERNAME, '--install-dir', dirs.a], {
    VIBETERM_PASSWORD: meshPassword,
  });

  await startInstance(dirs.relay);
  await waitHealthy(ports.relay);
  await waitUntil('relay health', async () => (await fetch(`${publicUrl}/api/relay/health`)).ok);
  log('relay healthy');
  await setRelayPassword(publicUrl, adminToken, relayPassword);

  await startInstance(dirs.a);
  await waitHealthy(ports.a);
  log('node A healthy');

  await enrollTenant({ aDir: dirs.a, publicUrl, relayPassword, meshPassword });
  const sessionA = await openSession(`http://127.0.0.1:${ports.a}`, meshPassword);
  const status = await waitTenantAttached(sessionA, publicUrl);
  log(`tenant attached id=${status.tenantId} metaEpoch=${status.metaEpoch}`);

  const joined = await joinNodeB({ bDir: dirs.b, session: sessionA, meshPassword });
  await startInstance(dirs.b);
  await waitHealthy(ports.b);
  log('node B healthy');

  const online = await waitNodeOnline(sessionA, NODE_B_NAME);
  log(`node B online id=${online.id}`);
  // 让 state 里 A 的 Cookie 头同时带上 B 的 node-session，curl 打 /n/<B> 才不会 401。
  await loginNode(sessionA, online.id);
  await probeViaEntry(sessionA, online.id);
  const remote = await waitTransport(sessionA, online.id);
  const localName =
    (await readMeshNodes(sessionA)).find((node) => node.id === sessionA.entryNodeId)?.name ?? '';
  log(`node B reachable via /n/${online.id} transport=${remote.transport ?? 'unknown'}`);
  const sessionB = await openSession(`http://127.0.0.1:${ports.b}`, meshPassword);
  const relaySession = await openSession(`http://127.0.0.1:${ports.relay}`, relayNodePassword);

  await Bun.write(
    statePath,
    `${JSON.stringify(
      buildState({
        supervisorPid: process.pid,
        tmpDir,
        username: USERNAME,
        password: meshPassword,
        tenantId: status.tenantId,
        tmuxSockets: TMUX_SOCKETS,
        dirs,
        ports,
        relay: {
          publicUrl,
          adminToken,
          username: RELAY_USERNAME,
          password: relayNodePassword,
          relayPassword,
          session: relaySession,
        },
        a: { name: localName, session: sessionA },
        b: {
          name: NODE_B_NAME,
          nodeId: joined.nodeId,
          transport: remote.transport,
          session: sessionB,
        },
      }),
      null,
      2
    )}\n`
  );
  log(`ready, state written to ${statePath}`);

  // 常驻：调用方 SIGTERM 本进程来回收整套环境。
  await new Promise(() => {});
}

await main().catch((error) => {
  process.stderr.write(`[relay-boot] ${error instanceof Error ? error.stack : String(error)}\n`);
  cleanup();
  process.exit(1);
});
