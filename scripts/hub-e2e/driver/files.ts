#!/usr/bin/env bun
import { collectTmexHeaders, sha256Hex } from './hash.ts';
import { apiFetch, joinUrl, loadLoginState, parseArgs, requireArg } from './lib.ts';

const args = parseArgs(process.argv.slice(2));
const cmd = String(args._ ?? '').trim();
const baseUrl = requireArg(args, 'base-url');
const login = await loadLoginState(requireArg(args, 'cookie-file'));
const cookies = login.cookies;
const nodeId = typeof args['node-id'] === 'string' ? args['node-id'] : '';

function prefix(path: string): string {
  return nodeId ? `/n/${nodeId}${path}` : path;
}

if (cmd === 'create-device') {
  const name = requireArg(args, 'name');
  const session = requireArg(args, 'session');
  const { res, json, text } = await apiFetch(baseUrl, prefix('/api/devices'), {
    method: 'POST',
    cookies,
    body: JSON.stringify({
      name,
      type: 'local',
      session,
      authMode: 'auto',
    }),
  });
  if (!res.ok) throw new Error(`create-device ${res.status}: ${text}`);
  process.stdout.write(`${JSON.stringify(json)}\n`);
  process.exit(0);
}

if (cmd === 'tmux-tree') {
  const deviceId = requireArg(args, 'device-id');
  const { res, json, text } = await apiFetch(
    baseUrl,
    `${prefix('/api/tmux/tree')}?deviceId=${encodeURIComponent(deviceId)}`,
    { cookies }
  );
  if (!res.ok) throw new Error(`tmux-tree ${res.status}: ${text}`);
  process.stdout.write(`${JSON.stringify(json)}\n`);
  process.exit(0);
}

if (cmd === 'create-root') {
  const deviceId = requireArg(args, 'device-id');
  const path = requireArg(args, 'path');
  const { res, json, text } = await apiFetch(baseUrl, prefix('/api/files/roots'), {
    method: 'POST',
    cookies,
    body: JSON.stringify({ deviceId, path, enabled: true }),
  });
  if (!res.ok) throw new Error(`create-root ${res.status}: ${text}`);
  process.stdout.write(`${JSON.stringify(json)}\n`);
  process.exit(0);
}

if (cmd === 'list') {
  const rootId = requireArg(args, 'root-id');
  const path = requireArg(args, 'path');
  const { res, json, text } = await apiFetch(
    baseUrl,
    `${prefix('/api/files/list')}?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`,
    { cookies }
  );
  if (!res.ok) throw new Error(`files/list ${res.status}: ${text}`);
  process.stdout.write(`${JSON.stringify(json)}\n`);
  process.exit(0);
}

if (cmd === 'content') {
  const rootId = requireArg(args, 'root-id');
  const path = requireArg(args, 'path');
  const { res, json, text } = await apiFetch(
    baseUrl,
    `${prefix('/api/files/content')}?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`,
    { cookies }
  );
  if (!res.ok) throw new Error(`files/content ${res.status}: ${text}`);
  process.stdout.write(`${JSON.stringify(json)}\n`);
  process.exit(0);
}

if (cmd === 'raw' || cmd === 'sha256') {
  const rootId = requireArg(args, 'root-id');
  const path = requireArg(args, 'path');
  const url = joinUrl(
    baseUrl,
    `${prefix('/api/files/raw')}?rootId=${encodeURIComponent(rootId)}&path=${encodeURIComponent(path)}`
  );
  const res = await fetch(url, {
    headers: { cookie: login.cookieHeader, origin: baseUrl },
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const body = {
    ok: res.ok,
    status: res.status,
    bytes: bytes.byteLength,
    sha256,
    headers: collectTmexHeaders(res.headers),
    bulkPath: 'browser-only',
  };
  process.stdout.write(`${JSON.stringify(body)}\n`);
  process.exit(res.ok ? 0 : 1);
}

if (cmd === 'get') {
  const path = requireArg(args, 'path');
  const { res, json, text } = await apiFetch(baseUrl, prefix(path), { cookies });
  process.stdout.write(
    `${JSON.stringify({ status: res.status, ok: res.ok, json, text }, null, 2)}\n`
  );
  process.exit(res.ok ? 0 : 1);
}

process.stderr.write(
  'usage: files.ts <create-device|tmux-tree|create-root|list|content|raw|sha256|get> --base-url --cookie-file [--node-id]\n'
);
process.exit(2);
