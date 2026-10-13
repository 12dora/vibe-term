// 文件管理器内部拖拽的载荷：写入 / 读取 DataTransfer，以及放置语义（移动 / 复制 / 不可放）。

import { fileDownloadUrl } from '@vibeterm/api-client';

export const EXPLORER_DRAG_MIME = 'application/x-vibeterm-files';

export interface ExplorerDragPayload {
  nodeId: string;
  rootId: string;
  deviceId: string;
  dir: string;
  paths: string[];
  names: string[];
  hasDirectory: boolean;
}

export type DropKind = 'move' | 'copy' | 'none';

export interface ExplorerDropDest {
  nodeId: string;
  deviceId: string;
  rootId: string;
  dir: string;
}

function defaultOrigin(): string {
  return (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
}

export function writeDragPayload(
  dt: DataTransfer,
  payload: ExplorerDragPayload,
  origin: string = defaultOrigin()
): void {
  dt.setData(EXPLORER_DRAG_MIME, JSON.stringify(payload));
  dt.effectAllowed = 'copyMove';
  if (payload.paths.length !== 1 || payload.hasDirectory) return;
  // 单个文件可直接拖到系统下载（仅 Chromium 生效，URL 必须绝对）
  const url = origin + fileDownloadUrl(payload.nodeId, payload.rootId, payload.paths[0]);
  const name = payload.names[0] ?? '';
  dt.setData('DownloadURL', `application/octet-stream:${name}:${url}`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDragPayload(value: unknown): value is ExplorerDragPayload {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const stringFields = ['nodeId', 'rootId', 'deviceId', 'dir'];
  if (!stringFields.every((field) => typeof candidate[field] === 'string')) return false;
  if (typeof candidate.hasDirectory !== 'boolean') return false;
  const { paths, names } = candidate;
  if (!isStringArray(paths) || !isStringArray(names)) return false;
  return paths.length > 0 && paths.length === names.length;
}

export function readDragPayload(dt: DataTransfer): ExplorerDragPayload | null {
  try {
    const raw = dt.getData(EXPLORER_DRAG_MIME);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isDragPayload(parsed)) return null;
    return {
      nodeId: parsed.nodeId,
      rootId: parsed.rootId,
      deviceId: parsed.deviceId,
      dir: parsed.dir,
      paths: [...parsed.paths],
      names: [...parsed.names],
      hasDirectory: parsed.hasDirectory,
    };
  } catch {
    return null;
  }
}

// Firefox 的 dataTransfer.types 是 DOMStringList（无 includes），故 Array.from。
export function hasExplorerDrag(dt: DataTransfer): boolean {
  return Array.from(dt.types as ArrayLike<string>).includes(EXPLORER_DRAG_MIME);
}

// dragover 阶段 getData 不可读，拖拽中的载荷在模块内留一份镜像（dragstart 写入、dragend 清空）。
let activeDrag: ExplorerDragPayload | null = null;

export function setActiveDrag(payload: ExplorerDragPayload | null): void {
  activeDrag = payload;
}

export function getActiveDrag(): ExplorerDragPayload | null {
  return activeDrag;
}

function isSelfOrDescendant(dir: string, path: string): boolean {
  if (dir === path) return true;
  return dir.startsWith(path.endsWith('/') ? path : `${path}/`);
}

function isBlockedDrop(payload: ExplorerDragPayload, destDir: string, kind: DropKind): boolean {
  if (payload.paths.includes(destDir)) return true;
  if (kind === 'move' && destDir === payload.dir) return true;
  return payload.hasDirectory && payload.paths.some((path) => isSelfOrDescendant(destDir, path));
}

/**
 * 同节点同设备 → 'move'（按住复制修饰键为 'copy'），否则 'copy'。
 * 放到自身、移动到原目录、目录放进自身或其子孙时为 'none'。
 */
export function resolveDropKind(
  payload: ExplorerDragPayload,
  dest: ExplorerDropDest,
  copyModifier: boolean
): DropKind {
  const sameNode = payload.nodeId === dest.nodeId;
  const movable = sameNode && payload.deviceId === dest.deviceId && !copyModifier;
  const kind: DropKind = movable ? 'move' : 'copy';
  const sameRoot = sameNode && payload.rootId === dest.rootId;
  return sameRoot && isBlockedDrop(payload, dest.dir, kind) ? 'none' : kind;
}
