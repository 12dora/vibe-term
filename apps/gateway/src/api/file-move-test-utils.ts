import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@vibeterm/shared';
import { createDevice } from '../db/devices';
import { createFileRoot, deleteFileRoot } from '../db/file-roots';
import { fileMoveRemoteIo } from '../files/move-remote';
import { fileMoveRoutes } from './file-move';
import { dispatchRoutes } from './route';

const createdRootIds: string[] = [];
const sandboxes: string[] = [];
const originalExec = fileMoveRemoteIo.exec;
const originalHooks = fileMoveRemoteIo.hooks;

/** 在每个用例的 afterEach 里调用：还原 ssh 注入、删除建出的 root 与临时目录。 */
export function cleanupMoveTest(): void {
  fileMoveRemoteIo.exec = originalExec;
  fileMoveRemoteIo.hooks = originalHooks;
  for (const id of createdRootIds) deleteFileRoot(id);
  createdRootIds.length = 0;
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  sandboxes.length = 0;
}

function makeDevice(id: string, type: Device['type']): Device {
  const now = new Date().toISOString();
  return {
    id,
    name: `dev-${id}`,
    type,
    host: type === 'ssh' ? '127.0.0.1' : undefined,
    username: type === 'ssh' ? 'nobody' : undefined,
    session: type === 'local' ? 'vibeterm' : undefined,
    authMode: type === 'ssh' ? 'agent' : 'auto',
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function newDevice(type: Device['type'] = 'local'): string {
  const id = `move-${crypto.randomUUID().slice(0, 8)}`;
  createDevice(makeDevice(id, type));
  return id;
}

export function rootOn(deviceId: string, path: string): string {
  const root = createFileRoot({ deviceId, path });
  createdRootIds.push(root.id);
  return root.id;
}

export interface Sandbox {
  dir: string;
  rootId: string;
  deviceId: string;
}

/** 一个本机根，内含空的 `dest` 子目录。 */
export function sandbox(deviceId = newDevice()): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-move-')));
  sandboxes.push(dir);
  mkdirSync(join(dir, 'dest'));
  return { dir, rootId: rootOn(deviceId, dir), deviceId };
}

export type Json = Record<string, unknown>;

async function post(
  route: 'move' | 'rename',
  body: unknown
): Promise<{ status: number; json: Json }> {
  const req = new Request(`http://localhost/api/files/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const pathname = new URL(req.url).pathname;
  const response = dispatchRoutes(req, pathname, fileMoveRoutes, { path: pathname });
  if (!response) throw new Error(`no route matched POST ${pathname}`);
  const resolved = await response;
  return { status: resolved.status, json: (await resolved.json()) as Json };
}

export const move = (body: unknown) => post('move', body);
export const rename = (body: unknown) => post('rename', body);

export const errorBody = (code: string, detail?: string) => ({ error: code, code, detail });
