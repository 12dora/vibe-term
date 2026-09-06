// relay-boot 写给调用方的 state JSON：schema 与 `--mode hub` 的说明都收在这里，
// 让 relay-boot.ts 只留编排逻辑。字段含义见 docs/testing/2026090604-relay-live-harness.md。

import { type Session, cookieHeader } from './relay-boot-auth.ts';

export interface InstanceState {
  role: string;
  name: string;
  port: number;
  peerPort: number;
  baseUrl: string;
  nodeId: string;
  tmuxSocket: string;
  installDir: string;
  cookie: string;
}

export interface BuildStateInput {
  supervisorPid: number;
  tmpDir: string;
  username: string;
  password: string;
  tenantId: string | null;
  tmuxSockets: Record<'relay' | 'a' | 'b', string>;
  dirs: { relay: string; a: string; b: string };
  ports: { relay: number; a: number; b: number; relayPeer: number; aPeer: number; bPeer: number };
  relay: {
    publicUrl: string;
    adminToken: string;
    username: string;
    password: string;
    relayPassword: string;
    session: Session;
  };
  a: { name: string; session: Session };
  b: { name: string; nodeId: string; transport: string | null; session: Session };
}

function instance(input: {
  role: string;
  name: string;
  port: number;
  peerPort: number;
  nodeId: string;
  tmuxSocket: string;
  installDir: string;
  cookies: Record<string, string>;
}): InstanceState {
  return {
    role: input.role,
    name: input.name,
    port: input.port,
    peerPort: input.peerPort,
    baseUrl: `http://127.0.0.1:${input.port}`,
    nodeId: input.nodeId,
    tmuxSocket: input.tmuxSocket,
    installDir: input.installDir,
    cookie: cookieHeader(input.cookies),
  };
}

export function buildState(input: BuildStateInput): Record<string, unknown> {
  const { ports, dirs, tmuxSockets } = input;
  return {
    mode: 'relay',
    supervisorPid: input.supervisorPid,
    tmpDir: input.tmpDir,
    username: input.username,
    password: input.password,
    uid: input.a.session.uid,
    tenantId: input.tenantId,
    relay: {
      ...instance({
        role: 'relay,node',
        name: 'relay',
        port: ports.relay,
        peerPort: ports.relayPeer,
        nodeId: input.relay.session.entryNodeId,
        tmuxSocket: tmuxSockets.relay,
        installDir: dirs.relay,
        cookies: input.relay.session.cookies,
      }),
      publicUrl: input.relay.publicUrl,
      adminToken: input.relay.adminToken,
      adminAuthHeader: `Bearer ${input.relay.adminToken}`,
      username: input.relay.username,
      password: input.relay.password,
      relayPassword: input.relay.relayPassword,
    },
    a: instance({
      role: 'node',
      name: input.a.name,
      port: ports.a,
      peerPort: ports.aPeer,
      nodeId: input.a.session.entryNodeId,
      tmuxSocket: tmuxSockets.a,
      installDir: dirs.a,
      cookies: input.a.session.cookies,
    }),
    b: {
      ...instance({
        role: 'node',
        name: input.b.name,
        port: ports.b,
        peerPort: ports.bPeer,
        nodeId: input.b.nodeId,
        tmuxSocket: tmuxSockets.b,
        installDir: dirs.b,
        cookies: input.b.session.cookies,
      }),
      transport: input.b.transport,
      // `/n/<B>` 需要入口机 A 的会话 + B 的 node-session，两个 cookie 都在 A 的 jar 里。
      viaA: {
        url: `http://127.0.0.1:${ports.a}/n/${input.b.nodeId}`,
        cookie: cookieHeader(input.a.session.cookies),
      },
    },
    tmuxSockets,
  };
}

export function hubModeHelp(): string {
  return [
    'hub 拓扑（hub,node + node）用既有的 mesh-boot.ts，本文件不复制它：',
    '',
    '  bun apps/fe/tests/helpers/mesh-boot.ts --state /tmp/tmex-mesh-e2e.json',
    '',
    'mesh-boot 会拉起 hub(19771+) + node，enroll/hub join 并入 mesh，把 baseUrl / hubNodeId /',
    'remoteNodeId / username / password 写进 state JSON，SIGTERM 回收全部进程与 tmux socket。',
    'relay 拓扑（relay,node + node + standalone）用本文件的 --state 模式。',
    '',
  ].join('\n');
}
