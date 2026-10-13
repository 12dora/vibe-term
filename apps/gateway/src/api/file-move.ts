import {
  type Device,
  FILE_OP_MAX_PATHS,
  type FileErrorCode,
  type MoveFileItemResult,
  type MoveFilesRequest,
  type MoveFilesResponse,
  type RenameFileRequest,
  type RenameFileResponse,
} from '@vibeterm/shared';
import { getDeviceById } from '../db';
import type { FileRootRecord } from '../db/file-roots';
import { resolveFileRoot } from '../files/file-root';
import { moveLocal } from '../files/move-local';
import { moveRemote } from '../files/move-remote';
import {
  type MoveBatch,
  type MoveItem,
  type MoveOutcome,
  isValidSegmentName,
  lexicalInside,
  posixBasename,
  posixDirname,
  posixJoin,
  posixNormalize,
} from '../files/move-types';
import { type FileOpResult, fail, ok } from '../files/rsync-operation';
import { t } from '../i18n';
import { codeError } from './file-http';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

interface RootDevice {
  root: FileRootRecord;
  device: Device;
}

type PlannedItem = { path: string; item: MoveItem } | { path: string; code: FileErrorCode };

function resolveRootDevice(rootId: string): FileOpResult<RootDevice> {
  const resolved = resolveFileRoot(rootId);
  if (!resolved.ok) return fail(resolved.code);
  const device = getDeviceById(resolved.root.deviceId);
  if (!device) return fail('device_not_found');
  return ok({ root: resolved.root, device });
}

function runBatch(device: Device, batch: MoveBatch): Promise<FileOpResult<MoveOutcome[]>> {
  if (device.type === 'local') return moveLocal(device.id, batch);
  return moveRemote(device, batch);
}

function planItem(rootPath: string, input: string): PlannedItem {
  const echoed = input.startsWith('/') ? posixNormalize(input) : input;
  const lexical = lexicalInside(rootPath, input);
  if (!lexical.ok) return { path: echoed, code: lexical.code };
  if (lexical.path === posixNormalize(rootPath)) return { path: lexical.path, code: 'invalid' };
  const name = posixBasename(lexical.path);
  const item: MoveItem = {
    path: lexical.path,
    parent: posixDirname(lexical.path),
    name,
    destName: name,
  };
  return { path: lexical.path, item };
}

function mergeResults(
  plan: readonly PlannedItem[],
  outcomes: readonly MoveOutcome[],
  destDir: string
): MoveFileItemResult[] {
  let next = 0;
  return plan.map((entry): MoveFileItemResult => {
    if (!('item' in entry)) return { path: entry.path, ok: false, code: entry.code };
    const outcome = outcomes[next++] ?? fail('unknown');
    if (!outcome.ok) return { path: entry.path, ok: false, code: outcome.code };
    return { path: entry.path, ok: true, dest: posixJoin(destDir, entry.item.destName) };
  });
}

export async function moveUnderRoot(
  req: MoveFilesRequest
): Promise<FileOpResult<MoveFilesResponse>> {
  const src = resolveRootDevice(req.rootId);
  if (!src.ok) return src;
  const dest =
    req.destRootId && req.destRootId !== req.rootId ? resolveRootDevice(req.destRootId) : src;
  if (!dest.ok) return dest;
  if (src.data.root.deviceId !== dest.data.root.deviceId) return fail('invalid', 'cross_device');

  const destDir = lexicalInside(dest.data.root.path, req.destDir);
  if (!destDir.ok) return fail(destDir.code);

  const plan = req.paths.map((path) => planItem(src.data.root.path, path));
  const items = plan.flatMap((entry) => ('item' in entry ? [entry.item] : []));
  let outcomes: MoveOutcome[] = [];
  if (items.length > 0) {
    const ran = await runBatch(src.data.device, {
      rootPath: src.data.root.path,
      destRootPath: dest.data.root.path,
      destDir: destDir.path,
      overwrite: req.onConflict === 'overwrite',
      items,
    });
    if (!ran.ok) return ran;
    outcomes = ran.data;
  }
  return ok({ results: mergeResults(plan, outcomes, destDir.path) });
}

export async function renameUnderRoot(
  req: RenameFileRequest
): Promise<FileOpResult<RenameFileResponse>> {
  if (!isValidSegmentName(req.name)) return fail('invalid');
  const resolved = resolveRootDevice(req.rootId);
  if (!resolved.ok) return resolved;
  const { root, device } = resolved.data;

  const plan = planItem(root.path, req.path);
  if (!('item' in plan)) return fail(plan.code);
  const item: MoveItem = { ...plan.item, destName: req.name };
  const ran = await runBatch(device, {
    rootPath: root.path,
    destRootPath: root.path,
    destDir: item.parent,
    overwrite: false,
    items: [item],
  });
  if (!ran.ok) return ran;
  const outcome = ran.data[0] ?? fail('unknown');
  if (!outcome.ok) return fail(outcome.code, outcome.detail);
  return ok({ path: posixJoin(item.parent, req.name) });
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.includes('\0');
}

function isPathList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= FILE_OP_MAX_PATHS &&
    value.every(isAbsolutePath)
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseOptionalRootId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return nonEmptyString(value);
}

function parseConflict(value: unknown): MoveFilesRequest['onConflict'] | null {
  if (value === undefined || value === 'fail' || value === 'overwrite') return value;
  return null;
}

function parseMoveBody(body: Record<string, unknown>): MoveFilesRequest | null {
  const rootId = nonEmptyString(body.rootId);
  const destRootId = parseOptionalRootId(body.destRootId);
  const onConflict = parseConflict(body.onConflict);
  if (!rootId || destRootId === null || onConflict === null) return null;
  if (!isPathList(body.paths) || !isAbsolutePath(body.destDir)) return null;
  return { rootId, paths: body.paths, destRootId, destDir: body.destDir, onConflict };
}

function parseRenameBody(body: Record<string, unknown>): RenameFileRequest | null {
  const rootId = nonEmptyString(body.rootId);
  if (!rootId || !isAbsolutePath(body.path) || typeof body.name !== 'string') return null;
  return { rootId, path: body.path, name: body.name };
}

function invalidRequest(): Response {
  return json({ error: t('apiError.invalidRequest') }, 400);
}

export async function handleMove(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  const parsed = body ? parseMoveBody(body) : null;
  if (!parsed) return invalidRequest();
  const result = await moveUnderRoot(parsed);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

export async function handleRename(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  const parsed = body ? parseRenameBody(body) : null;
  if (!parsed) return invalidRequest();
  const result = await renameUnderRoot(parsed);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

export const fileMoveRoutes: ApiRoute[] = [
  route({ method: 'POST', path: '/api/files/move', handler: (req) => handleMove(req) }),
  route({ method: 'POST', path: '/api/files/rename', handler: (req) => handleRename(req) }),
];
