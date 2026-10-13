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
  type ArchiveLimits,
  createArchiveStream,
  createArchiveStreamFromProcess,
  tarArchiveArgs,
  tarNameArgs,
} from '../files/archive-stream';
import { checkAndNormalize, statFile } from '../files/device-storage';
import { resolveFileRoot } from '../files/file-root';
import { SH_INSIDE_FN, SH_PHYS_FN, spawnRemoteScript } from '../files/remote-script';
import { type FileOpResult, fail, ok } from '../files/rsync-operation';
import { RsyncAuthError, type RsyncDeviceSpec, buildRsyncDeviceSpec } from '../files/ssh-command';
import { t } from '../i18n';
import { requestDispatchContext } from '../mesh/types';
import { quoteShellArg } from '../tmux-client/command-builder';
import { sessionMaxBytes } from '../transfer/limits';
import { codeError } from './file-http';
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
    // `/` 没有 basename：以父目录 `/` + 条目 `.` 表示
    const parent = norm.path === '/' ? '/' : posix.dirname(norm.path);
    if (parentDir !== null && parent !== parentDir) return fail('invalid');
    parentDir = parent;
    const name = norm.path === '/' ? '.' : posix.basename(norm.path);
    if (names.includes(name)) continue;
    names.push(name);
    paths.push(norm.path);
  }
  if (parentDir === null) return fail('invalid');
  // `.` 已包含 `/` 下的全部内容，其余条目只会重复打包
  if (names.includes('.')) return ok({ parentDir, names: ['.'], paths: ['/'] });
  return ok({ parentDir, names, paths });
}

function normalizedRoot(rootPath: string): string {
  return posix.normalize(rootPath).replace(/\/+$/, '') || '/';
}

function isInside(rootPath: string, absPath: string): boolean {
  const root = normalizedRoot(rootPath);
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
  const single = items.names.length === 1 && items.names[0] !== '.' ? items.names[0] : null;
  const base = single ?? (posix.basename(items.parentDir) || 'files');
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

function streamLimits(onClose?: () => void): ArchiveLimits {
  return {
    maxBytes: sessionMaxBytes(config.transferMaxBytes),
    onClose,
  };
}

type ArchiveBody = FileOpResult<ReadableStream<Uint8Array>>;

/**
 * 下载时按「当前」根路径重新校验每个条目（词法；本机还会核对 realpath）：票据存活期间根可能
 * 被改了路径，文件也可能被删除或换成指向根外的链接。返回值表示条目是否就是根本身。
 */
function revalidateTicket(
  device: Device,
  rootPath: string,
  ticket: ArchiveTicket
): FileOpResult<boolean> {
  const full: string[] = [];
  for (const name of ticket.names) {
    const norm = checkAndNormalize(device, rootPath, posix.join(ticket.parentDir, name));
    if (!norm.ok) return fail(norm.code);
    full.push(norm.path);
  }
  // 根本身的父目录合法地落在根外，只有「唯一条目恰好是当前根」才允许免去物理父目录核对
  return ok(full.length === 1 && full[0] === normalizedRoot(rootPath));
}

function openLocalArchive(ticket: ArchiveTicket): ArchiveBody {
  try {
    const argv = tarArchiveArgs(ticket.parentDir, ticket.names);
    return ok(createArchiveStream({ argv, ...streamLimits() }));
  } catch {
    return fail('unknown');
  }
}

const EXIT_ROOT = 60;
const EXIT_PARENT = 61;
const EXIT_OUTSIDE = 64;

function dieWith(code: number, reason: string): string {
  return `|| { echo ${quoteShellArg(reason)} >&2; exit ${code}; }`;
}

/**
 * 路径只做过词法检查，符号链接可能把父目录带出根：在启动 tar 的同一次远端执行里比对物理路径，
 * tar 直接在核对过的工作目录里跑。条目就是根本身时父目录在根之外，无需核对。
 */
function buildRemoteTarScript(
  rootPath: string,
  ticket: ArchiveTicket,
  rootItself: boolean
): string {
  const q = quoteShellArg;
  const lines: string[] = [];
  if (!rootItself) {
    lines.push(
      SH_PHYS_FN,
      SH_INSIDE_FN,
      `cd -- ${q(normalizedRoot(rootPath))} ${dieWith(EXIT_ROOT, 'archive_root_unreachable')}`,
      `phys ${dieWith(EXIT_ROOT, 'archive_root_unreachable')}`,
      'r=$PHYS',
      `cd -- ${q(ticket.parentDir)} ${dieWith(EXIT_PARENT, 'archive_parent_unreachable')}`,
      `phys ${dieWith(EXIT_PARENT, 'archive_parent_unreachable')}`,
      `inside "$PHYS" "$r" ${dieWith(EXIT_OUTSIDE, 'archive_parent_outside_root')}`
    );
  } else {
    lines.push(
      `cd -- ${q(ticket.parentDir)} ${dieWith(EXIT_PARENT, 'archive_parent_unreachable')}`
    );
  }
  lines.push(`exec tar -czf - ${tarNameArgs(ticket.names).map(q).join(' ')}`, '');
  return lines.join('\n');
}

async function remoteSpec(device: Device): Promise<FileOpResult<RsyncDeviceSpec>> {
  try {
    return ok(await buildRsyncDeviceSpec(device));
  } catch (error) {
    if (error instanceof RsyncAuthError) return fail(error.code, error.message);
    throw error;
  }
}

/**
 * 不用 `withDeviceRsync`：它在回调 resolve 时就清理 spec，而且会占着该设备的串行队列——
 * 一次长下载会把同设备的其它文件操作全部堵住。这里直接建 spec，交给流的 `onClose` 在
 * 流结束 / 出错 / 取消时清理，保证 ssh 子进程存活期间密钥与 askpass 文件都在。
 */
async function openRemoteArchive(
  device: Device,
  rootPath: string,
  ticket: ArchiveTicket,
  rootItself: boolean
): Promise<ArchiveBody> {
  const spec = await remoteSpec(device);
  if (!spec.ok) return spec;
  try {
    const proc = spawnRemoteScript(spec.data, buildRemoteTarScript(rootPath, ticket, rootItself));
    if (!proc) {
      spec.data.cleanup();
      return fail('unknown');
    }
    return ok(createArchiveStreamFromProcess(proc, streamLimits(spec.data.cleanup)));
  } catch {
    spec.data.cleanup();
    return fail('unknown');
  }
}

/** `filename=` 回退值只留可打印 ASCII（非 ASCII、引号、反斜杠换成 `_`），完整名字放 `filename*=`。 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]|["\\]/gu, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function archiveHeaders(name: string): Record<string, string> {
  // 总长度未知：不能带 Content-Length，也不支持 Range
  return {
    'Content-Type': 'application/gzip',
    'Content-Disposition': contentDisposition(name),
    'Cache-Control': 'no-store',
  };
}

async function handleArchiveDownload(req: Request, id: string): Promise<Response> {
  const ticket = lookupTicket(id, uidOf(req));
  if (!ticket) return codeError('not_found');
  const resolved = resolveFileRoot(ticket.rootId);
  if (!resolved.ok) return codeError(resolved.code);
  const device = getDeviceById(resolved.root.deviceId);
  if (!device) return codeError('device_not_found');

  const valid = revalidateTicket(device, resolved.root.path, ticket);
  if (!valid.ok) return codeError(valid.code, valid.detail);

  // 先建响应头：构造失败时不能留下已启动的进程
  let headers: Record<string, string>;
  try {
    headers = archiveHeaders(ticket.name);
  } catch {
    return codeError('unknown');
  }
  const body =
    device.type === 'local'
      ? openLocalArchive(ticket)
      : await openRemoteArchive(device, resolved.root.path, ticket, valid.data);
  if (!body.ok) return codeError(body.code, body.detail);
  return new Response(body.data, { status: 200, headers });
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
