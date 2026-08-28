#!/usr/bin/env bun
import {
  apiFetch,
  loadLoginState,
  parseArgs,
  requireArg,
  sleep,
} from './lib.ts';

interface HubNode {
  id: string;
  name: string;
  status?: string;
  online: boolean;
  version?: string | null;
  direct_capable?: boolean;
}

interface MeshNode {
  id: string;
  name: string;
  publicKey: string;
  online: boolean;
  reach: 'lan' | 'relay' | null;
  version: string | null;
  direct_capable: boolean;
  loggedIn: boolean;
  isHub: boolean;
}

function cookiesFromArgs(args: ReturnType<typeof parseArgs>) {
  if (typeof args['cookie-file'] === 'string') {
    return loadLoginState(args['cookie-file']).then((s) => s.cookies);
  }
  throw new Error('missing --cookie-file');
}

async function hubNodes(baseUrl: string, cookies: Record<string, string>): Promise<HubNode[]> {
  const { res, json, text } = await apiFetch(baseUrl, '/api/hub/nodes', { cookies });
  if (!res.ok) throw new Error(`GET /api/hub/nodes ${res.status}: ${text}`);
  return ((json as { nodes?: HubNode[] }).nodes ?? []) as HubNode[];
}

async function meshNodes(baseUrl: string, cookies: Record<string, string>): Promise<MeshNode[]> {
  const { res, json, text } = await apiFetch(baseUrl, '/api/mesh/nodes', { cookies });
  if (!res.ok) throw new Error(`GET /api/mesh/nodes ${res.status}: ${text}`);
  return ((json as { nodes?: MeshNode[] }).nodes ?? []) as MeshNode[];
}

function findByName<T extends { name: string; id?: string }>(
  nodes: T[],
  name: string
): T | undefined {
  return nodes.find((n) => n.name === name || n.id === name);
}

const args = parseArgs(process.argv.slice(2));
const cmd = String(args._ ?? '').trim();
const baseUrl = requireArg(args, 'base-url');
const cookies = await cookiesFromArgs(args);
const timeoutMs = Number(args.timeout ?? 60_000);

if (cmd === 'hub-list') {
  process.stdout.write(`${JSON.stringify({ nodes: await hubNodes(baseUrl, cookies) }, null, 2)}\n`);
  process.exit(0);
}

if (cmd === 'mesh-list') {
  process.stdout.write(`${JSON.stringify({ nodes: await meshNodes(baseUrl, cookies) }, null, 2)}\n`);
  process.exit(0);
}

if (cmd === 'wait-hub-online') {
  const names = requireArg(args, 'names').split(',').map((s) => s.trim()).filter(Boolean);
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const nodes = await hubNodes(baseUrl, cookies);
      last = JSON.stringify(nodes);
      const missing = names.filter((name) => {
        const row = findByName(nodes, name);
        return !row || row.online !== true;
      });
      if (missing.length === 0) {
        process.stdout.write(`${JSON.stringify({ ok: true, nodes }, null, 2)}\n`);
        process.exit(0);
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(2000);
  }
  process.stderr.write(`wait-hub-online timeout names=${names.join(',')} last=${last}\n`);
  process.exit(1);
}

if (cmd === 'wait-present') {
  const name = requireArg(args, 'name');
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const nodes = await meshNodes(baseUrl, cookies);
      last = JSON.stringify(nodes);
      const row = findByName(nodes, name);
      if (row) {
        process.stdout.write(`${JSON.stringify({ ok: true, node: row }, null, 2)}\n`);
        process.exit(0);
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(2000);
  }
  process.stderr.write(`wait-present timeout name=${name} last=${last}\n`);
  process.exit(1);
}

if (cmd === 'wait-reach') {
  const name = requireArg(args, 'name');
  const reach = requireArg(args, 'reach') as 'lan' | 'relay';
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const nodes = await meshNodes(baseUrl, cookies);
      last = JSON.stringify(nodes);
      const row = findByName(nodes, name);
      if (row && row.online === true && row.reach === reach) {
        process.stdout.write(`${JSON.stringify({ ok: true, node: row }, null, 2)}\n`);
        process.exit(0);
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(2000);
  }
  process.stderr.write(`wait-reach timeout name=${name} reach=${reach} last=${last}\n`);
  process.exit(1);
}

if (cmd === 'wait-direct-capable') {
  const name = requireArg(args, 'name');
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const nodes = await meshNodes(baseUrl, cookies);
      last = JSON.stringify(nodes);
      const row = findByName(nodes, name);
      if (row?.direct_capable === true) {
        process.stdout.write(`${JSON.stringify({ ok: true, node: row }, null, 2)}\n`);
        process.exit(0);
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(2000);
  }
  process.stderr.write(`wait-direct-capable timeout name=${name} last=${last}\n`);
  process.exit(1);
}

process.stderr.write(
  'usage: nodes.ts <hub-list|mesh-list|wait-hub-online|wait-reach|wait-direct-capable> --base-url --cookie-file ...\n'
);
process.exit(2);
