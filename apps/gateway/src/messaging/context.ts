import { type TmexRoles, isStandaloneRoles } from '@tmex/shared';
import type { CommandResult, CommandSpec, MeshNodeRef } from '@tmex/shared/messaging';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { decideAgentConfirmation, getAgentConfirmationById } from '../db/agent';
import { getDb as getOrmDb } from '../db/client';
import { listDevicesWithRuntimeStatus } from '../db/devices';
import { nodeIdentity, peerCache } from '../db/schema';
import { getSiteSettings } from '../db/site-settings';
import { t as translate } from '../i18n';
import { getDisplayVersion } from '../system/version';
import type { CommandRegistry } from './registry';

export type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

export type UplinkKind = 'hub' | 'relay' | 'none' | 'unknown';

export interface UplinkStatus {
  kind: UplinkKind;
  attached: boolean | 'unknown';
}

export interface MeshNodeView extends MeshNodeRef {
  version: string | null;
  current?: boolean;
}

export interface DeviceView {
  id: string;
  name: string;
  type: string;
  connected: boolean;
  lastError: string | null;
}

export interface TmuxPaneView {
  id: string;
  index: number;
  windowId: string;
  windowIndex: number;
  windowName: string;
  title?: string;
  active: boolean;
}

export interface TmuxWindowView {
  id: string;
  name: string;
  index: number;
  active: boolean;
  panes: TmuxPaneView[];
}

export type DecideConfirmationResult =
  | { ok: true }
  | { ok: false; code: 'notFound' | 'alreadyDecided' | 'unavailable' };

export type RemoteCommandExecutor = (
  invocationCommand: string,
  targetNodeId: string
) => Promise<CommandResult>;

export interface MessagingRuntimeHooks {
  getUplinkStatus?: () => UplinkStatus;
  listMeshNodes?: () => MeshNodeView[];
  getDeviceTree?: (deviceId: string) => TmuxWindowView[] | null;
  capturePane?: (deviceId: string, paneId: string, lines: number) => Promise<string>;
  sendKeys?: (deviceId: string, paneId: string, text: string) => Promise<void>;
  decideConfirmation?: (
    confirmationId: string,
    approved: boolean,
    reason?: string
  ) => DecideConfirmationResult;
  remoteExecutor?: RemoteCommandExecutor;
}

export interface CommandContext {
  t: TranslateFn;
  registry: CommandRegistry;
  localNodeId: string | null;
  localName: string;
  version: string;
  roles: TmexRoles;
  uplink: UplinkStatus;
  meshMode: 'standalone' | 'mesh';
  listNodes(): MeshNodeView[];
  listDevices(): DeviceView[];
  getWindows(deviceId: string): TmuxWindowView[] | null;
  capturePane(deviceId: string, paneId: string, lines: number): Promise<string>;
  sendKeys(deviceId: string, paneId: string, text: string): Promise<void>;
  decideConfirmation(
    confirmationId: string,
    approved: boolean,
    reason?: string
  ): DecideConfirmationResult;
  remoteExecutor?: RemoteCommandExecutor;
}

let hooks: MessagingRuntimeHooks = {};

export function registerMessagingRuntime(next: MessagingRuntimeHooks): void {
  hooks = next;
}

export function getMessagingRuntimeHooks(): MessagingRuntimeHooks {
  return hooks;
}

export function resetMessagingRuntime(): void {
  hooks = {};
}

export function errorResult(
  ctx: Pick<CommandContext, 't'>,
  code: string,
  params?: Record<string, string | number | boolean | null>
): CommandResult {
  return {
    error: { code, params },
    text: ctx.t(code, params),
  };
}

export function formatArgUsage(spec: CommandSpec): string {
  const parts = spec.args.map((arg) => {
    if (arg.rest) return `-- <${arg.name}>`;
    return arg.required ? `<${arg.name}>` : `[${arg.name}]`;
  });
  return [spec.name, ...parts].join(' ');
}

const IDENTITY_ROW_ID = 1;

export function loadLocalIdentity(): {
  nodeId: string | null;
  name: string | null;
  uplinkKind: 'hub' | 'relay' | null;
} {
  const row = getOrmDb()
    .select({
      nodeId: nodeIdentity.nodeId,
      name: nodeIdentity.name,
      uplinkKind: nodeIdentity.uplinkKind,
    })
    .from(nodeIdentity)
    .where(eq(nodeIdentity.id, IDENTITY_ROW_ID))
    .get();
  if (!row) return { nodeId: null, name: null, uplinkKind: null };
  return {
    nodeId: row.nodeId,
    name: row.name ?? null,
    uplinkKind: row.uplinkKind ?? null,
  };
}

function defaultUplinkStatus(standalone: boolean, kind: 'hub' | 'relay' | null): UplinkStatus {
  if (hooks.getUplinkStatus) return hooks.getUplinkStatus();
  if (standalone) return { kind: 'none', attached: false };
  if (kind === 'hub' || kind === 'relay') return { kind, attached: 'unknown' };
  return { kind: 'unknown', attached: 'unknown' };
}

function defaultListNodes(localNodeId: string | null, localName: string): MeshNodeView[] {
  if (hooks.listMeshNodes) return hooks.listMeshNodes();
  const peers = getOrmDb().select().from(peerCache).all();
  const views: MeshNodeView[] = peers.map((peer) => ({
    id: peer.nodeId,
    name: peer.name,
    online: false,
    version: peer.version ?? null,
    current: localNodeId != null && peer.nodeId === localNodeId,
  }));
  if (localNodeId && !views.some((node) => node.id === localNodeId)) {
    views.unshift({
      id: localNodeId,
      name: localName,
      online: true,
      version: getDisplayVersion(),
      current: true,
    });
  }
  return views;
}

function defaultListDevices(): DeviceView[] {
  return listDevicesWithRuntimeStatus().map((device) => ({
    id: device.id,
    name: device.name,
    type: device.type,
    connected: device.tmuxAvailable,
    lastError: device.lastError,
  }));
}

function defaultDecideConfirmation(
  confirmationId: string,
  approved: boolean,
  reason?: string
): DecideConfirmationResult {
  if (hooks.decideConfirmation) {
    return hooks.decideConfirmation(confirmationId, approved, reason);
  }
  const existing = getAgentConfirmationById(confirmationId);
  if (!existing) return { ok: false, code: 'notFound' };
  const decided = decideAgentConfirmation(confirmationId, {
    status: approved ? 'approved' : 'denied',
    reason: reason ?? null,
  });
  if (!decided) return { ok: false, code: 'alreadyDecided' };
  return { ok: true };
}

function defaultTranslate(key: string, params?: Record<string, unknown>): string {
  const language = getSiteSettings().language;
  return translate(key, { lng: language, ...(params ?? {}) });
}

export function createCommandContext(registry: CommandRegistry): CommandContext {
  const standalone = isStandaloneRoles(config.roles);
  const identity = loadLocalIdentity();
  const localName = identity.name?.trim() || getSiteSettings().siteName;
  const localNodeId = identity.nodeId;
  return {
    t: defaultTranslate,
    registry,
    localNodeId,
    localName,
    version: getDisplayVersion(),
    roles: config.roles,
    uplink: defaultUplinkStatus(standalone, identity.uplinkKind),
    meshMode: standalone ? 'standalone' : 'mesh',
    listNodes: () => defaultListNodes(localNodeId, localName),
    listDevices: defaultListDevices,
    getWindows: (deviceId) => hooks.getDeviceTree?.(deviceId) ?? null,
    capturePane: async (deviceId, paneId, lines) => {
      if (!hooks.capturePane) throw new Error('capture-unavailable');
      return hooks.capturePane(deviceId, paneId, lines);
    },
    sendKeys: async (deviceId, paneId, text) => {
      if (!hooks.sendKeys) throw new Error('send-unavailable');
      return hooks.sendKeys(deviceId, paneId, text);
    },
    decideConfirmation: defaultDecideConfirmation,
    remoteExecutor: hooks.remoteExecutor,
  };
}
