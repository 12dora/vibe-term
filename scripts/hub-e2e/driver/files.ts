#!/usr/bin/env bun
import { apiFetch, loadLoginState, parseArgs, requireArg } from './lib.ts';

const args = parseArgs(process.argv.slice(2));
const cmd = String(args._ ?? '').trim();
const baseUrl = requireArg(args, 'base-url');
const cookies = (await loadLoginState(requireArg(args, 'cookie-file'))).cookies;
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

if (cmd === 'get') {
  const path = requireArg(args, 'path');
  const { res, json, text } = await apiFetch(baseUrl, prefix(path), { cookies });
  process.stdout.write(
    `${JSON.stringify({ status: res.status, ok: res.ok, json, text }, null, 2)}\n`
  );
  process.exit(res.ok ? 0 : 1);
}

process.stderr.write(
  'usage: files.ts <create-device|tmux-tree|create-root|list|content|get> --base-url --cookie-file [--node-id]\n'
);
process.exit(2);
