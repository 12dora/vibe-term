import {
  LOGIN_RECORD_PAGE_DEFAULT_LIMIT,
  LOGIN_RECORD_PAGE_MAX_LIMIT,
  type LoginRecordOutcome,
} from '@vibeterm/shared';
import { readJsonObjectBody } from '../api/http';
import { jsonBody, jsonError } from '../mesh/session-middleware';
import {
  type LoginRecordService,
  LoginRecordSettingsError,
  getLoginRecordService,
  warnLoginRecord,
} from './login-records-service';
import type { LoginRecordListQuery } from './login-records-store';

const COLLECTION_PATH = '/api/auth/login-records';
const SETTINGS_PATH = '/api/auth/login-records/settings';

type SessionGate = (
  fn: (req: Request, uid: string | null) => Response | Promise<Response>
) => Response | Promise<Response>;

export function recordsOr405(req: Request, session: SessionGate): Response | Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === COLLECTION_PATH || path === SETTINGS_PATH) {
    return session((inner, uid) => dispatchLoginRecords(inner, uid, getLoginRecordService()));
  }
  return jsonError('method_not_allowed', 405);
}

export function loginRecordRoutes(
  session: (
    fn: (req: Request, uid: string | null) => Response | Promise<Response>
  ) => Response | Promise<Response>,
  service: () => LoginRecordService
): Record<string, () => Response | Promise<Response>> {
  const authed = () => session((req, uid) => dispatchLoginRecords(req, uid, service()));
  return {
    [`GET ${COLLECTION_PATH}`]: authed,
    [`DELETE ${COLLECTION_PATH}`]: authed,
    [`GET ${SETTINGS_PATH}`]: authed,
    [`PUT ${SETTINGS_PATH}`]: authed,
  };
}

export async function dispatchLoginRecords(
  req: Request,
  uid: string | null,
  service: LoginRecordService
): Promise<Response> {
  if (!uid) return jsonError('UNAUTHORIZED', 401);
  try {
    const path = new URL(req.url).pathname;
    if (path === SETTINGS_PATH) return await dispatchSettings(req, service);
    if (path === COLLECTION_PATH) return await dispatchCollection(req, service);
    return jsonError('method_not_allowed', 405);
  } catch (err) {
    if (err instanceof LoginRecordSettingsError) return jsonError('MALFORMED', 400);
    warnLoginRecord(err);
    return jsonError('INTERNAL', 500);
  }
}

async function dispatchSettings(req: Request, service: LoginRecordService): Promise<Response> {
  if (req.method === 'GET') return jsonBody(service.getSettings());
  if (req.method === 'PUT') return putSettings(req, service);
  return jsonError('method_not_allowed', 405);
}

async function dispatchCollection(req: Request, service: LoginRecordService): Promise<Response> {
  if (req.method === 'GET') return listRecords(req, service);
  if (req.method === 'DELETE') return jsonBody({ deleted: service.clear() });
  return jsonError('method_not_allowed', 405);
}

function listRecords(req: Request, service: LoginRecordService): Response {
  const parsed = parseListQuery(new URL(req.url));
  if (!parsed) return jsonError('MALFORMED', 400);
  return jsonBody(service.list(parsed));
}

async function putSettings(req: Request, service: LoginRecordService): Promise<Response> {
  const body = await readJsonObjectBody(req);
  return jsonBody(service.updateSettings(body));
}

function parseListQuery(url: URL): LoginRecordListQuery | null {
  const outcome = parseOutcome(url.searchParams.get('outcome'));
  if (!outcome) return null;
  const kind = parseKind(url.searchParams.get('kind'));
  if (!kind) return null;
  const limit = parseLimit(url.searchParams.get('limit'));
  if (limit === null) return null;
  const before = parseCursor(url.searchParams);
  if (before === null) return null;
  return { outcome, kind, limit, ...(before === undefined ? {} : { before }) };
}

function parseOutcome(raw: string | null): LoginRecordOutcome | null {
  if (raw === 'success' || raw === 'failed') return raw;
  return null;
}

function parseKind(raw: string | null): 'interactive' | 'all' | null {
  if (raw === null || raw === '') return 'interactive';
  if (raw === 'interactive' || raw === 'all') return raw;
  return null;
}

function parseLimit(raw: string | null): number | null {
  if (raw === null || raw === '') return LOGIN_RECORD_PAGE_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (value < 1 || value > LOGIN_RECORD_PAGE_MAX_LIMIT) return null;
  return value;
}

function parseCursor(params: URLSearchParams): LoginRecordListQuery['before'] | null {
  const atRaw = params.get('before');
  const idRaw = params.get('beforeId');
  const atMissing = atRaw === null || atRaw === '';
  const idMissing = idRaw === null || idRaw === '';
  if (atMissing && idMissing) return undefined;
  if (atMissing || idMissing) return null;
  if (!atRaw || !/^\d+$/.test(atRaw)) return null;
  const at = Number(atRaw);
  if (!Number.isSafeInteger(at)) return null;
  if (!idRaw || !/^[A-Za-z0-9-]{1,64}$/.test(idRaw)) return null;
  return { at, id: idRaw };
}
