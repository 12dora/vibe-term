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
  | 'already_exists'
  | 'device_not_found'
  | 'root_not_found'
  | 'root_disabled'
  | 'root_virtual'
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
  /** 网关合成、不落库。PATCH / DELETE 返回 400 `root_virtual` */
  virtual?: boolean;
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

// ---- 删除 / 移动 / 重命名 ----
/** 单次删除、移动、打包请求最多携带的路径数 */
export const FILE_OP_MAX_PATHS = 500;

/** `POST /api/files/delete`：目录递归删除；符号链接只删链接本身。根目录自身不可删（逐项 `invalid`）。 */
export interface DeleteFilesRequest {
  rootId: string;
  /** 绝对路径，须落在 root 内 */
  paths: string[];
}

/** 批量操作的逐项结果；请求级错误（root 不存在、参数非法）仍走 `FileErrorCode` 的 HTTP 错误 */
export interface FileOpItemResult {
  path: string;
  ok: boolean;
  code?: FileErrorCode;
}

export interface DeleteFilesResponse {
  results: FileOpItemResult[];
}

export type MoveConflictPolicy = 'fail' | 'overwrite';

/**
 * `POST /api/files/move`：同一设备内移动。源根与目标根必须绑定同一台设备，
 * 否则请求级 `invalid`（detail `cross_device`）——跨设备 / 跨节点用传输任务复制。
 */
export interface MoveFilesRequest {
  rootId: string;
  /** 绝对路径，须落在源 root 内 */
  paths: string[];
  /** 缺省与 `rootId` 相同 */
  destRootId?: string;
  /** 目标目录绝对路径，须已存在且落在目标 root 内 */
  destDir: string;
  /** 目标已有同名项：`fail`（缺省）逐项回 `already_exists`；`overwrite` 仅替换非目录 */
  onConflict?: MoveConflictPolicy;
}

export interface MoveFileItemResult extends FileOpItemResult {
  /** 成功时的新绝对路径 */
  dest?: string;
}

export interface MoveFilesResponse {
  results: MoveFileItemResult[];
}

/** `POST /api/files/rename`：原地改名，`name` 不得含路径分隔符；同名已存在回 `already_exists` */
export interface RenameFileRequest {
  rootId: string;
  path: string;
  name: string;
}

export interface RenameFileResponse {
  /** 改名后的绝对路径 */
  path: string;
}

// ---- 打包下载 ----
/** `POST /api/files/archive/prepare`：`paths` 须同属一个父目录 */
export interface PrepareArchiveRequest {
  rootId: string;
  paths: string[];
}

/** 随后 `GET /api/files/archive/:archiveId` 流式返回 tar.gz（无 Content-Length） */
export interface PrepareArchiveResponse {
  archiveId: string;
  /** 建议文件名，含 `.tar.gz` 后缀 */
  name: string;
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
  /**
   * 节点支持乱序区间写入（`PUT /api/files/upload/:id?offset=&length=`）。
   * 旧节点无此字段，客户端退回单流顺序追加。
   */
  ranged?: boolean;
}

/** `GET /api/files/upload/:id`：断线重连后据此只补发缺口 */
export interface UploadStatusResponse {
  size: number;
  received: number;
  complete: boolean;
  /** 已收区间 `[offset, length][]`，升序不重叠 */
  ranges: Array<[number, number]>;
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

/**
 * 虚拟文件根：节点一条启用的文件根都没有时，浏览退化为直接从文件系统根 `/` 开始。
 * 只在「零启用根」这一种情况下成立，运维一旦配置了白名单根，该 id 立即失效。
 * 不出现在 `GET /api/files/roots` 的返回里，由前端在列表为空时自行合成。
 */
export const VIRTUAL_FS_ROOT_ID = 'fs-root';

/**
 * 虚拟 home 根：绑定本机设备的 `$HOME`（realpath），始终可解析，除非用户已有启用根的展示名为 `home`。
 * 出现在 `GET /api/files/roots`（`virtual: true`），不落库。
 */
export const VIRTUAL_HOME_ROOT_ID = 'home-root';
