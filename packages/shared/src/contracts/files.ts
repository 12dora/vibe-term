// 文件浏览 / 传输契约

import type { DeviceType } from './devices';

export type FileCategory =
  | 'directory'
  | 'code'
  | 'markdown'
  | 'image'
  | 'pdf'
  | 'text'
  | 'archive'
  | 'audio'
  | 'video'
  | 'binary'
  | 'other';

/** 目录条目种类（symlink 单列，便于前端标注；category 反映链接目标的种类） */
export type FileEntryType = 'dir' | 'file' | 'symlink' | 'other';

/** 文件访问错误码（前后端共享，前端据此渲染节点错误态 / 触发安装流程） */
export type FileErrorCode =
  | 'invalid'
  | 'outside_roots'
  | 'not_found'
  | 'not_a_directory'
  | 'is_directory'
  | 'too_large'
  | 'binary'
  | 'permission_denied'
  | 'device_not_found'
  | 'root_not_found'
  | 'root_disabled'
  | 'connection_failed'
  | 'auth_unsupported'
  | 'rsync_missing_local'
  | 'rsync_missing_remote'
  | 'timeout'
  | 'unknown';

/** 白名单根目录（绑定到具体设备） */
export interface FileRootDto {
  id: string;
  /** 绑定设备 id */
  deviceId: string;
  /** 设备展示名（设备不存在时为 null） */
  deviceName: string | null;
  /** 设备类型（设备不存在时为 null） */
  deviceType: DeviceType | null;
  /** 绝对路径 */
  path: string;
  /** 展示名：路径 basename（根 '/' 显示为 /） */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  sortOrder: number;
}

export interface CreateFileRootRequest {
  deviceId: string;
  path: string;
  enabled?: boolean;
}

export interface UpdateFileRootRequest {
  path?: string;
  enabled?: boolean;
  sortOrder?: number;
}

/** 目录中的一个条目 */
export interface FileEntryDto {
  name: string;
  /** 绝对路径 */
  path: string;
  type: FileEntryType;
  category: FileCategory;
  /** 字节数；目录为 null */
  size: number | null;
  /** 最后修改时间 ISO 串；无法获取为 null */
  modifiedAt: string | null;
  /** 是否为符号链接 */
  isSymlink: boolean;
}

export interface ListFileRootsResponse {
  roots: FileRootDto[];
}

export interface FileRootResponse {
  root: FileRootDto;
}

export interface ListFilesResponse {
  /** 被列出的目录绝对路径 */
  path: string;
  entries: FileEntryDto[];
  /** 条目数超过上限被截断 */
  truncated: boolean;
}

export type FileContentEncoding = 'utf-8';

export interface FileContentResponse {
  path: string;
  name: string;
  category: FileCategory;
  encoding: FileContentEncoding;
  content: string;
  /** 文件实际字节数 */
  size: number;
  /** 内容因超限被截断 */
  truncated: boolean;
}

export interface FileStatResponse {
  path: string;
  name: string;
  type: FileEntryType;
  category: FileCategory;
  size: number;
  modifiedAt: string | null;
  mime: string | null;
  isSymlink: boolean;
}

// ---- 分块上传协议 ----
export interface UploadInitRequest {
  rootId: string;
  /** 目标目录绝对路径（须落在 root 内且为已存在目录） */
  path: string;
  name: string;
  size: number;
}

export interface UploadInitResponse {
  uploadId: string;
  chunkSize: number;
}

/** commit 阶段流式返回的 NDJSON 事件（rsync 推送进度 / 完成 / 失败） */
export type UploadCommitEvent =
  | { type: 'progress'; transferred: number; pct: number; rate: string }
  | { type: 'done'; uploaded: string }
  | { type: 'error'; code: FileErrorCode; detail?: string };

/** `GET /api/files/browse` 的单个子目录条目（图形化路径选择器，不受 file roots 白名单约束） */
export interface BrowseDirectoryEntryDto {
  name: string;
  /** 绝对路径 */
  path: string;
  hidden: boolean;
  /** 指向目录的符号链接 */
  symlink: boolean;
}

/**
 * `GET /api/files/browse?deviceId=&path=&hidden=` 响应。
 * `path` 为空时从设备默认目录（SSH 为登录用户 home，本机为 `os.homedir()`）开始；
 * 响应里的 `path` 为规范化后的绝对路径，`parent` 到根为 null。
 */
export interface BrowseDirectoryResponse {
  path: string;
  parent: string | null;
  /** 按名称排序，隐藏目录在 `hidden=true` 时才返回 */
  entries: BrowseDirectoryEntryDto[];
  /** 条目数达到上限被截断 */
  truncated: boolean;
}
