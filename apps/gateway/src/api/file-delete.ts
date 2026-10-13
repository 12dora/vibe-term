import { type DeleteFilesResponse, FILE_OP_MAX_PATHS, type FileErrorCode } from '@vibeterm/shared';
import { getDeviceById } from '../db';
import {
  type DeleteOutcome,
  type DeleteStatus,
  type DeleteTarget,
  deleteLocalTargets,
  posixNormalize,
} from '../files/delete-local';
import { deleteRemoteTargets } from '../files/delete-remote';
import { resolveFileRoot } from '../files/file-root';
import { type FileOpResult, fail, ok } from '../files/rsync-operation';
import { t } from '../i18n';
import { codeError } from './file-http';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

interface DeletePlan {
  path: string;
  /** 词法阶段就已判定失败（根自身 / 越界）；有值则不下发执行 */
  rejected?: FileErrorCode;
}

function planPath(normRoot: string, input: string): DeletePlan {
  if (!input.startsWith('/') || input.includes('\0')) return { path: input, rejected: 'invalid' };
  const path = posixNormalize(input);
  if (path === normRoot) return { path, rejected: 'invalid' };
  const prefix = normRoot === '/' ? '/' : `${normRoot}/`;
  if (!path.startsWith(prefix)) return { path, rejected: 'outside_roots' };
  return { path };
}

function toTargets(plans: readonly DeletePlan[]): DeleteTarget[] {
  const targets: DeleteTarget[] = [];
  plans.forEach((plan, index) => {
    if (!plan.rejected) targets.push({ index, path: plan.path });
  });
  return targets;
}

function toResults(
  plans: readonly DeletePlan[],
  outcome: DeleteOutcome
): DeleteFilesResponse['results'] {
  return plans.map((plan, index) => {
    const status: DeleteStatus = plan.rejected ?? outcome.get(index) ?? 'unknown';
    if (status === 'ok') return { path: plan.path, ok: true };
    return { path: plan.path, ok: false, code: status };
  });
}

export async function deleteUnderRoot(
  rootId: string,
  paths: string[]
): Promise<FileOpResult<DeleteFilesResponse>> {
  const resolved = resolveFileRoot(rootId);
  if (!resolved.ok) return fail(resolved.code);
  const device = getDeviceById(resolved.root.deviceId);
  if (!device) return fail('device_not_found');

  const rootPath = posixNormalize(resolved.root.path);
  const plans = paths.map((p) => planPath(rootPath, p));
  const targets = toTargets(plans);
  let outcome: FileOpResult<DeleteOutcome> = ok(new Map());
  if (targets.length > 0) {
    outcome =
      device.type === 'local'
        ? await deleteLocalTargets(device.id, rootPath, targets)
        : await deleteRemoteTargets(device, rootPath, targets);
  }
  if (!outcome.ok) return fail(outcome.code, outcome.detail);
  return ok({ results: toResults(plans, outcome.data) });
}

function parsePaths(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > FILE_OP_MAX_PATHS) return null;
  for (const item of raw) {
    if (typeof item !== 'string' || !item.startsWith('/') || item.includes('\0')) return null;
  }
  return raw as string[];
}

export async function handleDelete(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return json({ error: t('apiError.invalidRequest') }, 400);
  const rootId = typeof body.rootId === 'string' ? body.rootId : '';
  const paths = parsePaths(body.paths);
  if (!rootId || !paths) return json({ error: t('apiError.invalidRequest') }, 400);

  const result = await deleteUnderRoot(rootId, paths);
  if (!result.ok) return codeError(result.code, result.detail);
  return json(result.data);
}

export const fileDeleteRoutes: ApiRoute[] = [
  route({
    method: 'POST',
    path: '/api/files/delete',
    handler: (req) => handleDelete(req),
  }),
];
