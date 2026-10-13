// 拖入 / 选择「文件夹」时的展开：把一次拖放或一个 webkitdirectory 选择还原成
// 「要建的目录（父在前）+ 每个文件落在哪个相对目录」。纯逻辑，不发请求。

export const FOLDER_UPLOAD_MAX_FILES = 5000;
export const FOLDER_UPLOAD_MAX_DEPTH = 32;

export interface FolderUploadFile {
  file: File;
  /** 相对于投放目录的目录路径；顶层文件为 '' */
  relDir: string;
}

export interface FolderUploadPlan {
  files: FolderUploadFile[];
  /** 需要创建的全部目录（含空目录），父目录排在子目录之前 */
  dirs: string[];
}

export type FolderUploadLimit = 'tooManyFiles' | 'tooDeep';

export class FolderUploadLimitError extends Error {
  readonly limit: FolderUploadLimit;
  /** 超限的顶层文件夹名，用于提示 */
  readonly folderName: string;

  constructor(limit: FolderUploadLimit, folderName: string) {
    super(`folder upload limit exceeded: ${limit}`);
    this.name = 'FolderUploadLimitError';
    this.limit = limit;
    this.folderName = folderName;
  }
}

/** `FileSystemEntry` 家族的最小子集：单测可用普通对象替身 */
export interface DroppedEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

export interface DroppedFileEntry extends DroppedEntry {
  file(onSuccess: (file: File) => void, onError?: (error: unknown) => void): void;
}

export interface DroppedDirectoryReader {
  readEntries(
    onSuccess: (entries: DroppedEntry[]) => void,
    onError?: (error: unknown) => void
  ): void;
}

export interface DroppedDirectoryEntry extends DroppedEntry {
  createReader(): DroppedDirectoryReader;
}

interface CapturedDrop {
  entries: DroppedEntry[];
  /** 拿不到 entry 的条目（或整个 entry API 不可用）退回成顶层文件 */
  looseFiles: File[];
}

interface WalkState {
  files: FolderUploadFile[];
  dirs: Set<string>;
  /** 当前正在展开的顶层条目名 */
  topName: string;
}

type EntryCapableItem = DataTransferItem & {
  webkitGetAsEntry?: () => unknown;
};

function captureItem(item: EntryCapableItem, into: CapturedDrop): void {
  if (item.kind !== 'file') return;
  const entry =
    typeof item.webkitGetAsEntry === 'function'
      ? (item.webkitGetAsEntry() as DroppedEntry | null)
      : null;
  if (entry) {
    into.entries.push(entry);
    return;
  }
  const file = item.getAsFile();
  if (file) into.looseFiles.push(file);
}

// 必须在 drop 回调的同步阶段跑完：第一个 await 之后 DataTransfer 就被浏览器清空了。
function captureDrop(dt: DataTransfer): CapturedDrop {
  const captured: CapturedDrop = { entries: [], looseFiles: [] };
  const items = dt.items ? Array.from(dt.items) : [];
  for (const item of items) captureItem(item, captured);
  if (captured.entries.length === 0 && captured.looseFiles.length === 0) {
    captured.looseFiles = Array.from(dt.files ?? []);
  }
  return captured;
}

function readFile(entry: DroppedFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readBatch(reader: DroppedDirectoryReader): Promise<DroppedEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

// readEntries 每次只吐一批（Chromium 上限 100），要一直读到空批为止。
async function readAllEntries(directory: DroppedDirectoryEntry): Promise<DroppedEntry[]> {
  const reader = directory.createReader();
  const all: DroppedEntry[] = [];
  for (;;) {
    const batch = await readBatch(reader);
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function pushFile(state: WalkState, file: File, relDir: string): void {
  if (state.files.length >= FOLDER_UPLOAD_MAX_FILES) {
    throw new FolderUploadLimitError('tooManyFiles', state.topName);
  }
  state.files.push({ file, relDir });
}

async function walkEntry(
  entry: DroppedEntry,
  relDir: string,
  depth: number,
  state: WalkState
): Promise<void> {
  if (entry.isFile) {
    pushFile(state, await readFile(entry as DroppedFileEntry), relDir);
    return;
  }
  if (!entry.isDirectory) return;
  if (depth >= FOLDER_UPLOAD_MAX_DEPTH) {
    throw new FolderUploadLimitError('tooDeep', state.topName);
  }
  const dirPath = joinRel(relDir, entry.name);
  state.dirs.add(dirPath);
  const children = await readAllEntries(entry as DroppedDirectoryEntry);
  for (const child of children) await walkEntry(child, dirPath, depth + 1, state);
}

function depthOf(path: string): number {
  return path.split('/').length;
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** 父目录先于子目录；同层按字典序，结果稳定可测 */
export function sortDirsParentsFirst(dirs: Iterable<string>): string[] {
  return Array.from(dirs).sort((a, b) => depthOf(a) - depthOf(b) || compareText(a, b));
}

async function walkCaptured(captured: CapturedDrop): Promise<FolderUploadPlan> {
  const state: WalkState = { files: [], dirs: new Set(), topName: '' };
  for (const entry of captured.entries) {
    state.topName = entry.name;
    await walkEntry(entry, '', 0, state);
  }
  for (const file of captured.looseFiles) {
    state.topName = file.name;
    pushFile(state, file, '');
  }
  return { files: state.files, dirs: sortDirsParentsFirst(state.dirs) };
}

/**
 * 展开一次拖放。故意不是 async 函数：`captureDrop` 在返回 Promise 之前同步执行，
 * 调用方只要在 drop 回调里同步调用本函数即可，之后再 await 结果。
 */
export function collectDroppedItems(dt: DataTransfer): Promise<FolderUploadPlan> {
  let captured: CapturedDrop;
  try {
    captured = captureDrop(dt);
  } catch (error) {
    return Promise.reject(error);
  }
  return walkCaptured(captured);
}

// 相对路径只信任普通段：空段、`.`、`..` 一律丢弃，避免逃出投放目录。
function safeSegments(relativePath: string): string[] {
  return relativePath
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function addAncestors(dirs: Set<string>, segments: readonly string[]): string {
  let current = '';
  for (const segment of segments) {
    current = joinRel(current, segment);
    dirs.add(current);
  }
  return current;
}

/** `<input type="file" webkitdirectory>` 的选择结果：按 `webkitRelativePath` 还原目录结构。 */
export function filesFromDirectoryInput(fileList: ArrayLike<File>): FolderUploadPlan {
  const files: FolderUploadFile[] = [];
  const dirs = new Set<string>();
  for (const file of Array.from(fileList)) {
    const segments = safeSegments(file.webkitRelativePath ?? '');
    // 最后一段是文件名本身
    const dirSegments = segments.slice(0, -1);
    const topName = dirSegments[0] ?? file.name;
    if (dirSegments.length > FOLDER_UPLOAD_MAX_DEPTH) {
      throw new FolderUploadLimitError('tooDeep', topName);
    }
    if (files.length >= FOLDER_UPLOAD_MAX_FILES) {
      throw new FolderUploadLimitError('tooManyFiles', topName);
    }
    files.push({ file, relDir: addAncestors(dirs, dirSegments) });
  }
  return { files, dirs: sortDirsParentsFirst(dirs) };
}
