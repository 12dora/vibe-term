import { realpathSync } from 'node:fs';
import type { FileErrorCode, FileStatResponse } from '@vibeterm/shared';
import { getDeviceById } from '../db';
import { statFile } from '../files/device-storage';
import { resolveFileRoot } from '../files/file-root';
import { type FileOpResult, fail, ok } from '../files/rsync-operation';
import { t } from '../i18n';
import { joinPosix, resolveDestContext } from '../transfer/dest';
import { resolveAuthorizedDir } from '../transfer/dest-local';
import { ensureRemoteDir } from '../transfer/dest-remote';
import { codeError } from './file-http';
import { json, readJsonObjectBody } from './http';

export type MkdirResult = FileOpResult<{ path: string; created: boolean }>;

/** 与 `checkAndNormalize` 相同的词法规范化，但不做 local realpath（目标尚未存在）。 */
function posixNormalize(p: string): string {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return isAbs ? `/${joined}` : joined;
}

function lexicalNormalize(
  rootPath: string,
  inputPath: string
): { ok: true; path: string } | { ok: false; code: FileErrorCode } {
  if (!inputPath || inputPath.includes('\0') || !inputPath.startsWith('/')) {
    return { ok: false, code: 'invalid' };
  }
  const normRoot = posixNormalize(rootPath);
  const normPath = posixNormalize(inputPath);
  const prefix = normRoot === '/' ? '/' : `${normRoot}/`;
  if (!(normPath === normRoot || normPath.startsWith(prefix))) {
    return { ok: false, code: 'outside_roots' };
  }
  return { ok: true, path: normPath };
}

function segmentsUnder(rootPath: string, absPath: string): string[] {
  if (absPath === rootPath) return [];
  const prefix = rootPath === '/' ? '/' : `${rootPath}/`;
  return absPath.slice(prefix.length).split('/').filter(Boolean);
}

function mkdirLocal(rootPath: string, absPath: string, recursive: boolean): MkdirResult {
  let realRoot: string;
  try {
    realRoot = realpathSync(rootPath);
  } catch {
    return fail('root_not_found');
  }
  const segs = segmentsUnder(posixNormalize(rootPath), absPath);
  if (segs.length === 0) return ok({ path: absPath, created: false });

  const existing = resolveAuthorizedDir(realRoot, segs, false);
  if (existing.ok) return ok({ path: absPath, created: false });
  if (existing.code !== 'not_found') return fail(existing.code);

  if (!recursive) {
    const parent = resolveAuthorizedDir(realRoot, segs.slice(0, -1), false);
    if (!parent.ok) return fail(parent.code);
  }
  const made = resolveAuthorizedDir(realRoot, segs, true);
  if (!made.ok) return fail(made.code);
  return ok({ path: absPath, created: true });
}

function alreadyThere(st: FileOpResult<FileStatResponse>, absPath: string): MkdirResult | null {
  if (st.ok) {
    if (st.data.type === 'dir') return ok({ path: absPath, created: false });
    return fail('not_a_directory');
  }
  if (st.code !== 'not_found') return fail(st.code, st.detail);
  return null;
}

async function createRemoteDir(
  rootId: string,
  rootPath: string,
  absPath: string,
  segs: string[],
  recursive: boolean
): Promise<MkdirResult> {
  const parentSegs = recursive ? [] : segs.slice(0, -1);
  const rel = recursive ? segs.join('/') : segs[segs.length - 1];
  const parentAbs = parentSegs.reduce((dir, seg) => joinPosix(dir, seg), posixNormalize(rootPath));
  if (parentSegs.length > 0) {
    const parentSt = await statFile(rootId, parentAbs);
    if (!parentSt.ok) return fail(parentSt.code, parentSt.detail);
    if (parentSt.data.type !== 'dir') return fail('not_a_directory');
  }
  const ctx = resolveDestContext(rootId, parentAbs);
  if (!ctx.ok) return fail(ctx.code);
  const made = await ensureRemoteDir(ctx.data, rel);
  if (!made.ok) return fail(made.code, made.detail);
  return ok({ path: absPath, created: true });
}

async function mkdirRemote(
  rootId: string,
  rootPath: string,
  absPath: string,
  recursive: boolean
): Promise<MkdirResult> {
  const existed = alreadyThere(await statFile(rootId, absPath), absPath);
  if (existed) return existed;
  const segs = segmentsUnder(posixNormalize(rootPath), absPath);
  if (segs.length === 0) return ok({ path: absPath, created: false });
  return createRemoteDir(rootId, rootPath, absPath, segs, recursive);
}

export async function mkdirUnderRoot(
  rootId: string,
  inputPath: string,
  recursive: boolean
): Promise<MkdirResult> {
  const resolved = resolveFileRoot(rootId);
  if (!resolved.ok) return fail(resolved.code);
  const device = getDeviceById(resolved.root.deviceId);
  if (!device) return fail('device_not_found');

  const lexical = lexicalNormalize(resolved.root.path, inputPath);
  if (!lexical.ok) return fail(lexical.code);

  if (device.type === 'local') return mkdirLocal(resolved.root.path, lexical.path, recursive);
  return mkdirRemote(rootId, resolved.root.path, lexical.path, recursive);
}

function mkdirError(code: FileErrorCode, detail?: string): Response {
  if (code === 'not_a_directory') {
    return json({ error: 'not_a_directory', code: 'not_a_directory' }, 409);
  }
  return codeError(code, detail);
}

export async function handleMkdir(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return json({ error: t('apiError.invalidRequest') }, 400);
  const rootId = typeof body.rootId === 'string' ? body.rootId : '';
  const path = typeof body.path === 'string' ? body.path : '';
  if (!rootId || !path) return json({ error: t('apiError.invalidRequest') }, 400);

  const result = await mkdirUnderRoot(rootId, path, body.recursive === true);
  if (!result.ok) return mkdirError(result.code, result.detail);
  return json({ path: result.data.path, created: result.data.created });
}
