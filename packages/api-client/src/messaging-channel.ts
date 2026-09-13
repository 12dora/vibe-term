// 消息通道 REST 客户端工厂：路径与错误文案由 channel descriptor 参数化。

import type { ApiClient } from './client';
import { requestJson, requestOk } from './json-mutation';

export interface MessagingChannelClientDesc {
  basePath: string;
  parentLabel: string;
  childCollection: string;
  childLabel: string;
}

export type MessagingChannelFlags = {
  enabled?: boolean;
  allowAuthRequests?: boolean;
  allowCommands?: boolean;
};

export function messagingParentPath(basePath: string, id: string, suffix = ''): string {
  return `${basePath}/${encodeURIComponent(id)}${suffix}`;
}

export function messagingChildPath(
  desc: MessagingChannelClientDesc,
  parentId: string,
  childId: string,
  suffix = ''
): string {
  const children = messagingParentPath(desc.basePath, parentId, `/${desc.childCollection}`);
  return `${children}/${encodeURIComponent(childId)}${suffix}`;
}

export interface MessagingChannelClient {
  list<T>(): Promise<T>;
  create(body: unknown): Promise<unknown>;
  update(id: string, body: unknown): Promise<unknown>;
  remove(id: string): Promise<void>;
  listChildren<T>(parentId: string): Promise<T>;
  approveChild<T>(parentId: string, childId: string): Promise<T>;
  parentPath(id: string, suffix?: string): string;
  childPath(parentId: string, childId: string, suffix?: string): string;
}

function listParents<T>(desc: MessagingChannelClientDesc, client: ApiClient): Promise<T> {
  return requestJson<T>(client, desc.basePath, {
    errorFallback: `Failed to list ${desc.parentLabel}s`,
  });
}

function createParent(
  desc: MessagingChannelClientDesc,
  client: ApiClient,
  body: unknown
): Promise<unknown> {
  return requestJson(client, desc.basePath, {
    method: 'POST',
    body,
    errorFallback: `Failed to create ${desc.parentLabel}`,
  });
}

function updateParent(
  desc: MessagingChannelClientDesc,
  client: ApiClient,
  id: string,
  body: unknown
): Promise<unknown> {
  return requestJson(client, messagingParentPath(desc.basePath, id), {
    method: 'PATCH',
    body,
    errorFallback: `Failed to update ${desc.parentLabel}`,
  });
}

async function removeParent(
  desc: MessagingChannelClientDesc,
  client: ApiClient,
  id: string
): Promise<void> {
  await requestOk(client, messagingParentPath(desc.basePath, id), {
    method: 'DELETE',
    errorFallback: `Failed to delete ${desc.parentLabel}`,
  });
}

function listChildren<T>(
  desc: MessagingChannelClientDesc,
  client: ApiClient,
  parentId: string
): Promise<T> {
  return requestJson<T>(
    client,
    messagingParentPath(desc.basePath, parentId, `/${desc.childCollection}`),
    { errorFallback: `Failed to list ${desc.childLabel}s` }
  );
}

function approveChild<T>(
  desc: MessagingChannelClientDesc,
  client: ApiClient,
  parentId: string,
  childId: string
): Promise<T> {
  return requestJson<T>(client, messagingChildPath(desc, parentId, childId, '/approve'), {
    method: 'POST',
    errorFallback: `Failed to approve ${desc.childLabel}`,
  });
}

export function createMessagingChannelClient(
  desc: MessagingChannelClientDesc,
  client: ApiClient
): MessagingChannelClient {
  return {
    list: () => listParents(desc, client),
    create: (body) => createParent(desc, client, body),
    update: (id, body) => updateParent(desc, client, id, body),
    remove: (id) => removeParent(desc, client, id),
    listChildren: (parentId) => listChildren(desc, client, parentId),
    approveChild: (parentId, childId) => approveChild(desc, client, parentId, childId),
    parentPath: (id, suffix = '') => messagingParentPath(desc.basePath, id, suffix),
    childPath: (parentId, childId, suffix = '') =>
      messagingChildPath(desc, parentId, childId, suffix),
  };
}
