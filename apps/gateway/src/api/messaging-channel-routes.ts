// 消息通道 REST 工厂：路径 /api/settings/{channel}/{parents}，JSON 信封由 descriptor 决定。

import { t } from '../i18n';
import {
  type ConfigFieldSpec,
  type FieldParseResult,
  applyConfigFields,
  parseBooleanField,
} from './config-field';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

export function parseRequiredTrimmed(raw: unknown, error: string): FieldParseResult<string> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, error };
  return { ok: true, value };
}

export function parseMessagingFlag(raw: unknown): FieldParseResult<boolean> {
  return parseBooleanField(raw, t('apiError.invalidRequest'));
}

export interface MessagingChannelRouteDesc<
  TCreate extends object,
  TUpdate extends object,
  TParent,
  TChild,
> {
  channel: string;
  parentCollection: string;
  childCollection: string;
  parentParam: string;
  childParam: string;
  listKey: string;
  childListKey: string;
  childKey: string;
  parentNotFound: () => string;
  childNotFound: () => string;
  createFields: ConfigFieldSpec<unknown>[];
  updateFields: ConfigFieldSpec<unknown>[];
  getById: (id: string) => TParent | null;
  listWithStats: () => unknown;
  listChildren: (parentId: string) => unknown;
  approveChild: (parentId: string, childId: string) => TChild | null;
  persistCreate: (draft: TCreate) => Promise<Record<string, unknown>>;
  persistUpdate: (id: string, draft: TUpdate) => Promise<void>;
  persistDelete: (id: string) => Promise<void>;
  afterApprove?: (parent: TParent, childId: string) => Promise<void>;
}

type AnyRouteDesc = MessagingChannelRouteDesc<object, object, unknown, unknown>;

async function parseBodyFields<T extends object>(
  req: Request,
  fields: readonly ConfigFieldSpec<unknown>[]
): Promise<{ ok: true; fields: T } | { ok: false; response: Response }> {
  const raw = await readJsonObjectBody(req);
  if (!raw) return { ok: false, response: json({ error: t('apiError.invalidRequest') }, 400) };
  const parsed = applyConfigFields<T>(raw, fields, undefined);
  if (!parsed.ok) return { ok: false, response: json({ error: parsed.error }, 400) };
  return { ok: true, fields: parsed.fields };
}

function parentNotFound(desc: AnyRouteDesc, id: string): Response | null {
  if (desc.getById(id)) return null;
  return json({ error: desc.parentNotFound() }, 404);
}

async function handleList(desc: AnyRouteDesc): Promise<Response> {
  return json({ [desc.listKey]: desc.listWithStats() });
}

async function handleCreate(req: Request, desc: AnyRouteDesc): Promise<Response> {
  const parsed = await parseBodyFields(req, desc.createFields);
  if (!parsed.ok) return parsed.response;
  const extra = await desc.persistCreate(parsed.fields);
  return json({ success: true, ...extra }, 201);
}

async function handleUpdate(req: Request, desc: AnyRouteDesc, id: string): Promise<Response> {
  const missing = parentNotFound(desc, id);
  if (missing) return missing;
  const parsed = await parseBodyFields(req, desc.updateFields);
  if (!parsed.ok) return parsed.response;
  await desc.persistUpdate(id, parsed.fields);
  return json({ success: true });
}

async function handleDelete(desc: AnyRouteDesc, id: string): Promise<Response> {
  const missing = parentNotFound(desc, id);
  if (missing) return missing;
  await desc.persistDelete(id);
  return json({ success: true });
}

async function handleListChildren(desc: AnyRouteDesc, parentId: string): Promise<Response> {
  const missing = parentNotFound(desc, parentId);
  if (missing) return missing;
  return json({ [desc.childListKey]: desc.listChildren(parentId) });
}

async function handleApprove(
  desc: AnyRouteDesc,
  parentId: string,
  childId: string
): Promise<Response> {
  const parent = desc.getById(parentId);
  if (!parent) return json({ error: desc.parentNotFound() }, 404);
  const child = desc.approveChild(parentId, childId);
  if (!child) return json({ error: desc.childNotFound() }, 404);
  if (desc.afterApprove) await desc.afterApprove(parent, childId);
  return json({ [desc.childKey]: child });
}

export function createMessagingChannelRoutes<
  TCreate extends object,
  TUpdate extends object,
  TParent,
  TChild,
>(desc: MessagingChannelRouteDesc<TCreate, TUpdate, TParent, TChild>): ApiRoute[] {
  const inner = desc as unknown as AnyRouteDesc;
  const parentBase: string = `/api/settings/${desc.channel}/${desc.parentCollection}`;
  const parentItem: string = `${parentBase}/:${desc.parentParam}`;
  const childBase: string = `${parentItem}/${desc.childCollection}`;
  const childItem: string = `${childBase}/:${desc.childParam}`;
  const approvePath: string = `${childItem}/approve`;
  return [
    route({ method: 'GET', path: parentBase, handler: () => handleList(inner) }),
    route({ method: 'POST', path: parentBase, handler: (req) => handleCreate(req, inner) }),
    route({
      method: 'PATCH',
      path: parentItem,
      handler: (req, params) => handleUpdate(req, inner, params[desc.parentParam]),
    }),
    route({
      method: 'DELETE',
      path: parentItem,
      handler: (_req, params) => handleDelete(inner, params[desc.parentParam]),
    }),
    route({
      method: 'GET',
      path: childBase,
      handler: (_req, params) => handleListChildren(inner, params[desc.parentParam]),
    }),
    route({
      method: 'POST',
      path: approvePath,
      handler: (_req, params) =>
        handleApprove(inner, params[desc.parentParam], decodeURIComponent(params[desc.childParam])),
    }),
  ];
}
