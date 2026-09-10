// `vibeterm devices`：节点上的设备与分组。

import type { DeviceWithRuntime } from '@vibeterm/api-client/devices';
import { flagString } from '../core/args';
import {
  type SubHandler,
  confirmOrYes,
  dash,
  emit,
  rejectExtra,
  requireArg,
  requireObjectBody,
  resolveJsonBody,
  runSubs,
  shortId,
  yn,
} from '../core/cmd';
import type { CliContext } from '../core/context';
import { deviceMutationBody, parseOrderIds } from '../core/devices-body';
import { UsageError } from '../core/errors';
import type { Command } from './types';

const FLAGS = {
  name: 'string',
  type: 'string',
  host: 'string',
  port: 'number',
  user: 'string',
  'auth-mode': 'string',
  password: 'string',
  'password-stdin': 'boolean',
  'password-file': 'string',
  'private-key': 'string',
  'private-key-stdin': 'boolean',
  'private-key-file': 'string',
  passphrase: 'string',
  'passphrase-stdin': 'boolean',
  'passphrase-file': 'string',
  session: 'string',
  cwd: 'string',
  'ssh-config': 'string',
  yes: 'boolean',
  ids: 'string',
  body: 'string',
} as const;

const USAGE = [
  'Usage: vibeterm devices <subcommand>',
  '',
  'Subcommands:',
  '  ls [--node]                      list devices',
  '  show <device>                    one device',
  '  add --name --type local|ssh …    POST /api/devices',
  '  edit <device> …                  PATCH /api/devices/:id',
  '  rm <device> [--yes]              DELETE /api/devices/:id',
  '  test <device>                    POST /api/devices/:id/test-connection',
  '  order --ids a,b,c                PUT /api/devices/order',
  '  folders ls|add|rm|layout         /api/device-folders',
  '',
  'add/edit flags: --name --type --host --port --user --auth-mode',
  '  --password --private-key --passphrase --session --cwd --ssh-config --body',
  'Secrets: prefer --password-stdin / --password-file / @file / VIBETERM_DEVICE_PASSWORD',
  '  (same for --private-key and --passphrase; argv values warn on stderr).',
  '',
  '--json shapes: { devices } / Device / { device } / TestConnectionResult / DeviceFolderLayout',
].join('\n');

async function resolveDevice(ctx: CliContext, ref: string): Promise<DeviceWithRuntime> {
  const nodeId = await ctx.targetNodeId();
  return ctx.resolver.resolveDevice(nodeId, ref);
}

const ls: SubHandler = async (ctx, _flags, positionals) => {
  rejectExtra(positionals, 0);
  const nodeId = await ctx.targetNodeId();
  const devices = await ctx.resolver.listDevices(nodeId);
  emit(ctx, { devices }, () => {
    ctx.out.table(devices, [
      { header: 'NAME', value: (row) => row.name },
      { header: 'ID', value: (row) => shortId(row.id) },
      { header: 'TYPE', value: (row) => row.type },
      { header: 'HOST', value: (row) => dash(row.host) },
      { header: 'TMUX', value: (row) => yn(row.tmuxAvailable) },
      { header: 'ERROR', value: (row) => dash(row.lastError) },
    ]);
  });
};

const show: SubHandler = async (ctx, _flags, positionals) => {
  const ref = requireArg(positionals, 0, 'device');
  rejectExtra(positionals, 1);
  const device = await resolveDevice(ctx, ref);
  emit(ctx, device, () => ctx.out.data(device));
};

const add: SubHandler = async (ctx, flags, positionals) => {
  rejectExtra(positionals, 0);
  const nodeId = await ctx.targetNodeId();
  const body = await deviceMutationBody(ctx, flags, { name: true, type: true });
  const result = await ctx.http.json(nodeId, 'POST', '/api/devices', body);
  emit(ctx, result, () => ctx.out.data(result));
};

const edit: SubHandler = async (ctx, flags, positionals) => {
  const ref = requireArg(positionals, 0, 'device');
  rejectExtra(positionals, 1);
  const device = await resolveDevice(ctx, ref);
  const body = await deviceMutationBody(ctx, flags, {});
  const result = await ctx.http.json(
    await ctx.targetNodeId(),
    'PATCH',
    `/api/devices/${device.id}`,
    body
  );
  emit(ctx, result, () => ctx.out.data(result));
};

const rm: SubHandler = async (ctx, flags, positionals) => {
  const ref = requireArg(positionals, 0, 'device');
  rejectExtra(positionals, 1);
  const device = await resolveDevice(ctx, ref);
  await confirmOrYes(flags, `delete device ${device.name}`);
  const nodeId = await ctx.targetNodeId();
  await ctx.http.json(nodeId, 'DELETE', `/api/devices/${device.id}`);
  emit(ctx, { ok: true, id: device.id }, () => ctx.out.line(`deleted ${device.name}`));
};

const test: SubHandler = async (ctx, _flags, positionals) => {
  const ref = requireArg(positionals, 0, 'device');
  rejectExtra(positionals, 1);
  const device = await resolveDevice(ctx, ref);
  const nodeId = await ctx.targetNodeId();
  const result = await ctx.http.json(nodeId, 'POST', `/api/devices/${device.id}/test-connection`);
  emit(ctx, result, () => ctx.out.data(result));
};

const order: SubHandler = async (ctx, flags, positionals) => {
  const ids = parseOrderIds(flagString(flags, 'ids'), positionals);
  const nodeId = await ctx.targetNodeId();
  const result = await ctx.http.json(nodeId, 'PUT', '/api/devices/order', { deviceIds: ids });
  emit(ctx, result, () => ctx.out.data(result));
};

const folders: SubHandler = async (ctx, flags, positionals) => {
  const action = requireArg(positionals, 0, 'folders action (ls|add|rm|layout)');
  const nodeId = await ctx.targetNodeId();
  if (action === 'ls') {
    rejectExtra(positionals, 1);
    const layout = await ctx.http.json(nodeId, 'GET', '/api/device-folders');
    emit(ctx, layout, () => ctx.out.data(layout));
    return;
  }
  if (action === 'add') {
    const name = flagString(flags, 'name') ?? positionals[1];
    if (!name) throw new UsageError('missing folder name', 'pass --name or a positional name');
    const result = await ctx.http.json(nodeId, 'POST', '/api/device-folders', { name });
    emit(ctx, result, () => ctx.out.data(result));
    return;
  }
  if (action === 'rm') {
    const id = requireArg(positionals, 1, 'folder id');
    await confirmOrYes(flags, `delete folder ${id}`);
    await ctx.http.json(nodeId, 'DELETE', `/api/device-folders/${id}`);
    emit(ctx, { ok: true, id }, () => ctx.out.line(`deleted folder ${id}`));
    return;
  }
  if (action === 'layout') {
    const body = requireObjectBody(
      await resolveJsonBody(flagString(flags, 'body')),
      'pass --body with { folders, placements }'
    );
    const result = await ctx.http.json(nodeId, 'PUT', '/api/device-folders/layout', body);
    emit(ctx, result, () => ctx.out.data(result));
    return;
  }
  throw new UsageError(`unknown folders action: ${action}`, 'use ls|add|rm|layout');
};

const HANDLERS: Record<string, SubHandler> = {
  ls,
  show,
  add,
  edit,
  rm,
  test,
  order,
  folders,
};

export const command: Command = {
  name: 'devices',
  summary: 'manage devices on a node',
  usage: USAGE,
  flags: FLAGS,
  run: (ctx, argv) => runSubs(ctx, argv, FLAGS, HANDLERS, 'run: vibeterm devices --help'),
};
