import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import {
  type Device,
  FILE_OP_MAX_PATHS,
  type PrepareArchiveRequest,
  type PrepareArchiveResponse,
} from '@vibeterm/shared';
import { config } from '../config';
import { getDeviceById } from '../db';
import {
  ARCHIVE_IDLE_TIMEOUT_MS,
  type ArchiveStreamOptions,
  buildSshInvocation,
  createArchiveStream,
  tarArchiveArgs,
} from '../files/archive-stream';
import { checkAndNormalize, statFile } from '../files/device-storage';
import { resolveFileRoot } from '../files/file-root';
import { type FileOpResult, fail, ok } from '../files/rsync-operation';
import { RsyncAuthError, buildRsyncDeviceSpec } from '../files/ssh-command';
import { t } from '../i18n';
import { requestDispatchContext } from '../mesh/types';
import { sessionMaxBytes } from '../transfer/limits';
import { attachmentHeaders, codeError } from './file-http';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

const TICKET_TTL_MS = 5 * 60_000;
const MAX_TICKETS = 256;

interface ArchiveTicket {
  id: string;
  uid: string | null;
  rootId: string;
  parentDir: string;
  names: string[];
  name: string;
  expiresAt: number;
}

const tickets = new Map<string, ArchiveTicket>();

/** 测试里替换时钟来验证过期。 */
export const archiveTicketClock = { now: (): number => Date.now() };

export function resetArchiveTickets(): void {
  tickets.clear();
}

function sweepExpired(): void {
  const now = archiveTicketClock.now();
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(id);
  }
}

function uidOf(req: Request): string | null {
  return requestDispatchContext.get(req)?.uid ?? null;
}

function lookupTicket(id: string, uid: string | null): ArchiveTicket | null {
  const ticket = tickets.get(id);
  if (!ticket) return null;
  if (ticket.expiresAt <= archiveTicketClock.now()) {
    tickets.delete(id);
    return null;
  }
  // 别人的票据与不存在同样返回 404，不泄露 id 是否有效
  return ticket.uid === uid ? ticket : null;
}

interface NormalizedItems {
  parentDir: string;
  names: string[];
  paths: string[];
}

function normalizeItems(
  device: Device,
  rootPath: string,
  inputs: readonly string[]
): FileOpResult<NormalizedItems> {
  const names: string[] = [];
  const paths: string[] = [];
  let parentDir: string | null = null;
  for (const input of inputs) {
    const norm = checkAndNormalize(device, rootPath, input);
    if (!norm.ok) return fail(norm.code);
    // 打包 `/` 本身没有 basename 可用，且没有意义
    if (norm.path === '/') return fail('invalid');
    const parent = posix.dirname(norm.path);
    if (parentDir !== null && parent !== parentDir) return fail('invalid');
    parentDir = parent;
    const name = posix.basename(norm.path);
    if (names.includes(name)) continue;
    names.push(name);
    paths.push(norm.path);
  }
  if (parentDir === null) return fail('invalid');
  return ok({ parentDir, names, paths });
}

function isInside(rootPath: string, absPath: string): boolean {
  const root = posix.normalize(rootPath).replace(/\/+$/, '') || '/';
  if (absPath === root) return true;
  return absPath.startsWith(root === '/' ? '/' : `${root}/`);
}

/** SSH：路径只做了词法检查，再确认一次父目录存在且不是普通文件；父目录在根之外时说明条目就是根本身。 */
async function checkRemoteParent(
  rootId: string,
  rootPath: string,
  items: NormalizedItems
): Promise<FileOpResult<null>> {
  const target = isInside(rootPath, items.parentDir) ? items.parentDir : items.paths[0];
  const st = await statFile(rootId, target);
  if (!st.ok) return fail(st.code, st.detail);
  if (st.data.type === 'file') return fail('not_a_directory');
  return ok(null);
}

function suggestedName(items: NormalizedItems): string {
  const base =
    items.names.length === 1 ? items.names[0] : posix.basename(items.parentDir) || 'files';
  return `${base}.tar.gz`;
}

function issueTicket(
  rootId: string,
  uid: string | null,
  items: NormalizedItems
): FileOpResult<PrepareArchiveResponse> {
  if (tickets.size >= MAX_TICKETS) sweepExpired();
  if (tickets.size >= MAX_TICKETS) return fail('invalid', 'too_many_archives');
  const ticket: ArchiveTicket = {
    id: randomBytes(32).toString('base64url'),
    uid,
    rootId,
    parentDir: items.parentDir,
    names: items.names,
    name: suggestedName(items),
    expiresAt: archiveTicketClock.now() + TICKET_TTL_MS,
  };
  tickets.set(ticket.id, ticket);
  return ok({ archiveId: ticket.id, name: ticket.name });
}

export async function prepareArchive(
  request: PrepareArchiveRequest,
  uid: string | null
): Promise<FileOpResult<PrepareArchiveResponse>> {
  if (request.paths.length === 0 || request.paths.length > FILE_OP_MAX_PATHS) {
    return fail('invalid');
  }
  const resolved = resolveFileRoot(request.rootId);
  if (!resolved.ok) return fail(resolved.code);
  const device = getDeviceById(resolved.root.deviceId);
  if (!device) return fail('device_not_found');

  const items = normalizeItems(device, resolved.root.path, request.paths);
  if (!items.ok) return items;
  if (device.type !== 'local') {
    const parent = await checkRemoteParent(request.rootId, resolved.root.path, items.data);
    if (!parent.ok) return parent;
  }
  return issueTicket(request.rootId, uid, items.data);
}

function parsePrepareBody(body: Record<string, unknown>): PrepareArchiveRequest | null {
  const rootId = typeof body.rootId === 'string' ? body.rootId : '';
  const paths = body.paths;
  if (!rootId || !Array.isArray(paths)) return null;
  if (paths.length < 1 || paths.length > FILE_OP_MAX_PATHS) return null;
  const valid = paths.every(
    (p): p is string => typeof p === 'string' && p.startsWith('/') && !p.includes('\0')
  );
  return valid ? { rootId, paths } : null;
}

async function handlePrepare(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  const parsed = body ? parsePrepareBody(body) : null;
  if (!parsed) return json({ error: t('apiError.invalidRequest') }, 400);
  const result = await prepareArchive(parsed, uidOf(req));
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

function streamOptions(argv: string[]): ArchiveStreamOptions {
  return {
    argv,
    idleMs: ARCHIVE_IDLE_TIMEOUT_MS,
    maxBytes: sessionMaxBytes(config.transferMaxBytes),
  };
}

type ArchiveBody = FileOpResult<ReadableStream<Uint8Array>>;

/** 下载时再校验一遍：票据存活期间文件可能已被删除或被换成指向根外的链接。 */
function openLocalArchive(device: Device, rootPath: string, ticket: ArchiveTicket): ArchiveBody {
  for (const name of ticket.names) {
    const norm = checkAndNormalize(device, rootPath, posix.join(ticket.parentDir, name));
    if (!norm.ok) return fail(norm.code);
  }
  try {
    const argv = tarArchiveArgs(ticket.parentDir, ticket.names);
    return ok(createArchiveStream(streamOptions(argv)));
  } catch {
    return fail('unknown');
  }
}

/**
 * 不用 `withDeviceRsync`：它在回调 resolve 时就清理 spec，而且会占着该设备的串行队列——
 * 一次长下载会把同设备的其它文件操作全部堵住。这里直接建 spec，交给流的 `onClose` 在
 * 流结束 / 出错 / 取消时清理，保证 ssh 子进程存活期间密钥与 askpass 文件都在。
 */
async function openRemoteArchive(device: Device, ticket: ArchiveTicket): Promise<ArchiveBody> {
  let spec: Awaited<ReturnType<typeof buildRsyncDeviceSpec>>;
  try {
    spec = await buildRsyncDeviceSpec(device);
  } catch (error) {
    if (error instanceof RsyncAuthError) return fail(error.code, error.message);
    throw error;
  }
  const invocation = buildSshInvocation(spec, tarArchiveArgs(ticket.parentDir, ticket.names));
  if (!invocation) {
    spec.cleanup();
    return fail('unknown');
  }
  try {
    const stream = createArchiveStream({
      ...streamOptions(invocation.argv),
      env: invocation.env,
      onClose: spec.cleanup,
    });
    return ok(stream);
  } catch {
    return fail('unknown');
  }
}

function archiveHeaders(name: string): Record<string, string> {
  const base = attachmentHeaders(name, 'application/gzip', 0);
  // 总长度未知：不能带 Content-Length，也不支持 Range
  return Object.fromEntries(
    Object.entries(base).filter(([key]) => key !== 'Content-Length' && key !== 'Accept-Ranges')
  );
}

async function handleArchiveDownload(req: Request, id: string): Promise<Response> {
  const ticket = lookupTicket(id, uidOf(req));
  if (!ticket) return codeError('not_found');
  const resolved = resolveFileRoot(ticket.rootId);
  if (!resolved.ok) return codeError(resolved.code);
  const device = getDeviceById(resolved.root.deviceId);
  if (!device) return codeError('device_not_found');

  const body =
    device.type === 'local'
      ? openLocalArchive(device, resolved.root.path, ticket)
      : await openRemoteArchive(device, ticket);
  if (!body.ok) return codeError(body.code, body.detail);
  return new Response(body.data, { status: 200, headers: archiveHeaders(ticket.name) });
}

export const fileArchiveRoutes: ApiRoute[] = [
  route({
    method: 'POST',
    path: '/api/files/archive/prepare',
    handler: (req) => handlePrepare(req),
  }),
  route({
    method: 'GET',
    path: '/api/files/archive/:id',
    handler: (req, params) => handleArchiveDownload(req, decodeURIComponent(params.id)),
  }),
];
