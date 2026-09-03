#!/usr/bin/env bun
// mesh e2e 的进程主管：拉起「hub,node」+「node」两个从源码运行的 tmex runtime，
// 走真实的 hub user add / enroll / hub join 流程把 node 并入 mesh，最后把连接信息
// 写进 state JSON 供 Playwright spec 读取。收到 SIGTERM/SIGINT 时回收全部子进程、
// tmux socket 与临时目录。
//
// 用法：bun apps/fe/tests/helpers/mesh-boot.ts --state /tmp/tmex-mesh-e2e-<pid>.json

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { resolve } from 'node:path';
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
} from '../../../../packages/shared/src/auth/index.ts';
import { parseEnvFile } from '../../../../packages/shared/src/env/load-env.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CLI_AUTH = resolve(REPO_ROOT, 'packages/app/src/cli-auth-entry.ts');
const RUNTIME_SERVER = resolve(REPO_ROOT, 'packages/app/src/runtime/server.ts');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'apps/gateway/drizzle');
const FE_DIST_DIR = resolve(REPO_ROOT, 'apps/fe/dist');

const HUB_TMUX_SOCKET = 'tmex-mesh-e2e-hub';
const NODE_TMUX_SOCKET = 'tmex-mesh-e2e-node';
const REMOTE_NODE_NAME = 'mesh-node-b';
const USERNAME = 'alice';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function log(message: string): void {
  process.stdout.write(`[mesh-boot] ${message}\n`);
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

function generatePassword(): string {
  return `TmexE2e!${encodeBase64url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

function testMasterKey(): string {
  const key = parseEnvFile(readFileSync(resolve(REPO_ROOT, 'test.env'), 'utf8')).TMEX_MASTER_KEY;
  if (!key) throw new Error('TMEX_MASTER_KEY missing from test.env');
  return key;
}

interface InstanceSpec {
  dir: string;
  roles: string;
  port: number;
  peerPort: number;
  tmuxSocket: string;
  hubUrl: string;
  hubPublicUrl: string;
}

function renderAppEnv(spec: InstanceSpec, masterKey: string): string {
  return `${[
    'NODE_ENV=test',
    `TMEX_ROLES=${spec.roles}`,
    `TMEX_MASTER_KEY=${masterKey}`,
    `GATEWAY_PORT=${spec.port}`,
    'TMEX_BIND_HOST=127.0.0.1',
    `DATABASE_URL=${spec.dir}/tmex.db`,
    `TMEX_BASE_URL=http://localhost:${spec.port}`,
    `TMEX_HUB_URL=${spec.hubUrl}`,
    `TMEX_HUB_PUBLIC_URL=${spec.hubPublicUrl}`,
    `TMEX_PEER_PORT=${spec.peerPort}`,
    'TMEX_PEER_BIND_HOST=127.0.0.1',
    'TMEX_STUN_SERVERS=',
    // Playwright 的浏览器从 loopback 连过来，客户端来源会被判成 trusted-local，
    // 通行密钥二次验证等按来源收紧的策略会被整体豁免。打开信任代理之后用例可以用
    // `x-forwarded-for` 显式声明来源是公网，强路径与豁免路径都能在同一套实例上验。
    // 只影响 x-forwarded-* / x-real-ip / cf-connecting-ip 的解读，不带这些头的请求
    // 仍然按 socket IP 判定（见 apps/gateway/src/mesh/client-ip.ts）。
    'TMEX_TRUST_PROXY=true',
    `TMEX_TMUX_SOCKET=${spec.tmuxSocket}`,
    'TMEX_SITE_NAME=tmex',
  ].join('\n')}\n`;
}

const children = new Set<Bun.Subprocess>();

function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'test',
    TMEX_MIGRATIONS_DIR: MIGRATIONS_DIR,
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
  if (code !== 0) {
    throw new Error(`cli ${args.join(' ')} exited ${code}\n${out}\n${err}`);
  }
  return out;
}

async function readAppEnv(dir: string): Promise<Record<string, string>> {
  return parseEnvFile(await Bun.file(`${dir}/app.env`).text());
}

async function startInstance(
  dir: string,
  extraEnv: Record<string, string>
): Promise<Bun.Subprocess> {
  const env = await readAppEnv(dir);
  const proc = Bun.spawn([process.execPath, RUNTIME_SERVER], {
    cwd: REPO_ROOT,
    env: {
      ...(process.env as Record<string, string>),
      ...env,
      TMEX_MIGRATIONS_DIR: MIGRATIONS_DIR,
      ...extraEnv,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.add(proc);
  return proc;
}

async function waitHealthy(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/healthz`);
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`gateway on ${port} never became healthy: ${last}`);
}

interface AuthMode {
  nodeId: string;
  uid: string;
  kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number };
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

// 与浏览器一致的密码登录：Argon2 seed → Ed25519 root → delegation → challenge/login。
// 只用于 boot 阶段轮询 /api/mesh/nodes 的在线状态，spec 里的登录仍然走真实 UI。
async function apiLogin(
  baseUrl: string,
  password: string
): Promise<{ cookies: Record<string, string>; mode: AuthMode }> {
  const modeRes = await fetch(`${baseUrl}/api/auth/mode`);
  const mode = (await modeRes.json()) as AuthMode;
  const seed = await deriveSeed(password, {
    salt: decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  });
  const rootKey = rootKeyFromSeed(seed);
  const sess = generateEd25519KeyPair();
  const delegation = createDelegation(rootKey, {
    uid: mode.uid,
    sessPk: sess.publicKey,
    now: Date.now(),
  });
  const challengeRes = await fetch(`${baseUrl}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uid: mode.uid }),
  });
  const challenge = (await challengeRes.json()) as {
    challenge_id: string;
    nonce: string;
    nodePk: string;
  };
  const login = buildLogin({
    challengeId: challenge.challenge_id,
    nonce: decodeBase64url(challenge.nonce),
    target: 'self',
    targetPk: decodeBase64url(challenge.nodePk),
    uid: mode.uid,
    entry: 'self',
  });
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(sess.secretKey, login)),
      delegation: encodeBase64url(delegation.bytes),
      delegation_sig: encodeBase64url(delegation.sig),
    }),
  });
  if (!loginRes.ok) {
    throw new Error(`api login failed ${loginRes.status}: ${await loginRes.text()}`);
  }
  const cookies: Record<string, string> = {};
  for (const line of loginRes.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return { cookies, mode };
}

interface MeshNodeRow {
  id: string;
  name: string;
  online: boolean;
  isHub: boolean;
}

async function waitRemoteNodeOnline(
  baseUrl: string,
  cookies: Record<string, string>,
  name: string,
  timeoutMs = 90_000
): Promise<MeshNodeRow> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/mesh/nodes`, {
        headers: { cookie: cookieHeader(cookies) },
      });
      const body = (await res.json()) as { nodes?: MeshNodeRow[] };
      last = JSON.stringify(body);
      const row = body.nodes?.find((node) => node.name === name);
      if (row?.online) return row;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(1000);
  }
  throw new Error(`node ${name} never came online: ${last}`);
}

function ensureFeDist(): void {
  if (existsSync(`${FE_DIST_DIR}/index.html`) && process.env.TMEX_MESH_E2E_BUILD_FE !== '1') {
    return;
  }
  log('building apps/fe (dist missing or TMEX_MESH_E2E_BUILD_FE=1)');
  const result = spawnSync('bun', ['run', '--filter', '@tmex/fe', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error('apps/fe build failed; mesh e2e serves the built dist from the hub gateway');
  }
}

function killTmuxSocket(socket: string): void {
  // socket 名固定为 mesh e2e 专用，绝不会命中默认 socket / 生产 tmex session。
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
  killTmuxSocket(HUB_TMUX_SOCKET);
  killTmuxSocket(NODE_TMUX_SOCKET);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  const statePath = arg('state');
  if (!statePath) throw new Error('missing --state <path>');

  ensureFeDist();

  const tmpDir = `/tmp/tmex-mesh-e2e-${process.pid}-${Date.now()}`;
  tmpDirRef = tmpDir;
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  const hubDir = `${tmpDir}/hub`;
  const nodeDir = `${tmpDir}/node`;
  mkdirSync(hubDir, { recursive: true });
  mkdirSync(nodeDir, { recursive: true });

  const masterKey = testMasterKey();
  const password = generatePassword();
  const hubPort = await findFreePort(19771);
  const nodePort = await findFreePort(hubPort + 1);
  const hubPeerPort = await findFreePort(39771);
  const nodePeerPort = await findFreePort(hubPeerPort + 1);
  const baseUrl = `http://localhost:${hubPort}`;

  await Bun.write(
    `${hubDir}/app.env`,
    renderAppEnv(
      {
        dir: hubDir,
        roles: 'hub,node',
        port: hubPort,
        peerPort: hubPeerPort,
        tmuxSocket: HUB_TMUX_SOCKET,
        hubUrl: '',
        hubPublicUrl: baseUrl,
      },
      masterKey
    )
  );
  await Bun.write(
    `${nodeDir}/app.env`,
    renderAppEnv(
      {
        dir: nodeDir,
        roles: 'standalone',
        port: nodePort,
        peerPort: nodePeerPort,
        tmuxSocket: NODE_TMUX_SOCKET,
        hubUrl: '',
        hubPublicUrl: '',
      },
      masterKey
    )
  );

  killTmuxSocket(HUB_TMUX_SOCKET);
  killTmuxSocket(NODE_TMUX_SOCKET);

  log(`hub=${hubPort} node=${nodePort} tmp=${tmpDir}`);
  await runCli(['hub', 'user', 'add', USERNAME, '--install-dir', hubDir], {
    TMEX_PASSWORD: password,
  });

  await startInstance(hubDir, { TMEX_FE_DIST_DIR: FE_DIST_DIR });
  await waitHealthy(hubPort);
  log('hub healthy');

  // enroll 会一直等到 node 兑换 token 后自签 admit-node，必须与 hub join 并发跑。
  const enroll = Bun.spawn(
    [process.execPath, CLI_AUTH, 'enroll', '--ttl', '10m', '--install-dir', hubDir],
    {
      cwd: REPO_ROOT,
      env: cliEnv({ TMEX_PASSWORD: password }),
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  children.add(enroll);
  const enrollOutput = { text: '' };
  const enrollReader = (async () => {
    for await (const chunk of enroll.stdout as ReadableStream<Uint8Array>) {
      enrollOutput.text += new TextDecoder().decode(chunk);
    }
  })();

  const token = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const match = /join token: ([A-Za-z0-9_-]+)/.exec(enrollOutput.text);
      if (match?.[1]) return match[1];
      await Bun.sleep(200);
    }
    throw new Error(`enroll never printed a join token: ${enrollOutput.text}`);
  })();
  log(`enroll token ready (len=${token.length})`);

  await runCli([
    'hub',
    'join',
    baseUrl,
    '--token',
    token,
    '--name',
    REMOTE_NODE_NAME,
    '--insecure-local',
    '--no-restart',
    '--install-dir',
    nodeDir,
  ]);

  const nodeEnv = await readAppEnv(nodeDir);
  if (nodeEnv.TMEX_ROLES !== 'node' || nodeEnv.TMEX_HUB_URL !== baseUrl) {
    throw new Error(
      `hub join did not persist roles/hub url: roles=${nodeEnv.TMEX_ROLES} hub=${nodeEnv.TMEX_HUB_URL}`
    );
  }

  await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (enrollOutput.text.includes('node admitted')) return;
      await Bun.sleep(200);
    }
    throw new Error(`enroll never admitted the node: ${enrollOutput.text}`);
  })();
  enroll.kill('SIGTERM');
  children.delete(enroll);
  await enrollReader.catch(() => undefined);
  log('node admitted');

  await startInstance(nodeDir, {});
  await waitHealthy(nodePort);
  log('node healthy');

  const { cookies, mode } = await apiLogin(baseUrl, password);
  const remote = await waitRemoteNodeOnline(baseUrl, cookies, REMOTE_NODE_NAME);
  log(`remote node online id=${remote.id}`);

  await Bun.write(
    statePath,
    `${JSON.stringify(
      {
        baseUrl,
        hubPort,
        nodePort,
        username: USERNAME,
        password,
        uid: mode.uid,
        hubNodeId: mode.nodeId,
        remoteNodeId: remote.id,
        remoteNodeName: REMOTE_NODE_NAME,
        hubTmuxSocket: HUB_TMUX_SOCKET,
        nodeTmuxSocket: NODE_TMUX_SOCKET,
        supervisorPid: process.pid,
        tmpDir,
      },
      null,
      2
    )}\n`
  );
  log(`ready, state written to ${statePath}`);

  // 常驻：Playwright 的 mesh teardown project 会 SIGTERM 本进程来回收整套环境。
  await new Promise(() => {});
}

await main().catch((error) => {
  process.stderr.write(`[mesh-boot] ${error instanceof Error ? error.stack : String(error)}\n`);
  cleanup();
  process.exit(1);
});
