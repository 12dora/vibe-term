// 上传前的同名冲突检查：哪些文件落点已经存在（会被覆盖）、哪些是干净的。
// 目录列表怎么取由调用方注入，这里只负责「查哪些目录」与「怎么判冲突」。

import type { FolderUploadFile, FolderUploadPlan } from './folder-upload';

/** 一次上传最多探测这么多次（列目录 + 截断目录下的逐个 stat）；超出的按「未发现冲突」处理 */
export const UPLOAD_CONFLICT_PROBE_LIMIT = 200;

const PROBE_CONCURRENCY = 6;

/** 键是相对目标目录的目录路径（'' = 目标目录自身），值是该目录下已存在的名称 */
export type ExistingNamesByDir = ReadonlyMap<string, ReadonlySet<string>>;

export interface UploadConflictPlan {
  conflicts: FolderUploadFile[];
  clean: FolderUploadFile[];
}

export function planUploadConflicts(
  files: readonly FolderUploadFile[],
  existingByDir: ExistingNamesByDir
): UploadConflictPlan {
  const conflicts: FolderUploadFile[] = [];
  const clean: FolderUploadFile[] = [];
  for (const item of files) {
    const taken = existingByDir.get(item.relDir)?.has(item.file.name) ?? false;
    (taken ? conflicts : clean).push(item);
  }
  return { conflicts, clean };
}

/** 提示里展示的名称：带上相对目录，便于分辨不同子目录里的同名文件 */
export function conflictDisplayName(item: FolderUploadFile): string {
  return item.relDir ? `${item.relDir}/${item.file.name}` : item.file.name;
}

/** `missing` = 目录不存在（必然无冲突）；`unknown` = 没查到（网络等），不能据此推断子目录 */
export type DirProbe = { names: readonly string[]; truncated: boolean } | 'missing' | 'unknown';

export interface ConflictProbeIo {
  list(relDir: string): Promise<DirProbe>;
  /** 列表被截断时逐个确认；查不到一律当不存在 */
  exists(relDir: string, name: string): Promise<boolean>;
  limit?: number;
}

interface KnownDir {
  names: Set<string>;
  /** 列表完整：名字不在其中即可断定不存在 */
  complete: boolean;
}

interface ProbeBudget {
  left: number;
}

function relDepth(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length;
}

function splitRel(dir: string): { parent: string; name: string } {
  const index = dir.lastIndexOf('/');
  return index < 0
    ? { parent: '', name: dir }
    : { parent: dir.slice(0, index), name: dir.slice(index + 1) };
}

// 父目录的完整列表里没有它 → 它不存在，其下也就不可能有冲突，省掉一次请求。
function isKnownMissing(dir: string, known: ReadonlyMap<string, KnownDir>): boolean {
  if (dir === '') return false;
  const { parent, name } = splitRel(dir);
  const parentState = known.get(parent);
  return parentState?.complete === true && !parentState.names.has(name);
}

/** 按深度分层（浅层在前），保证判断子目录时父目录已有结论 */
function levelsOf(dirs: Iterable<string>): string[][] {
  const byDepth = new Map<number, string[]>();
  for (const dir of new Set(dirs)) {
    const depth = relDepth(dir);
    const level = byDepth.get(depth);
    if (level) level.push(dir);
    else byDepth.set(depth, [dir]);
  }
  return Array.from(byDepth.keys())
    .sort((a, b) => a - b)
    .map((depth) => byDepth.get(depth) ?? []);
}

async function inChunks<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += PROBE_CONCURRENCY) {
    await Promise.all(items.slice(start, start + PROBE_CONCURRENCY).map(run));
  }
}

function namesByDir(files: readonly FolderUploadFile[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const { file, relDir } of files) {
    const group = groups.get(relDir);
    if (group) group.push(file.name);
    else groups.set(relDir, [file.name]);
  }
  return groups;
}

// 目标目录自身总是要查（通常命中缓存）：整棵新文件夹往往凭它一次就能判定「全都不存在」。
function pickProbeTargets(
  level: readonly string[],
  wanted: ReadonlyMap<string, string[]>,
  known: Map<string, KnownDir>,
  budget: ProbeBudget
): string[] {
  const targets: string[] = [];
  for (const dir of level) {
    if (isKnownMissing(dir, known)) {
      known.set(dir, { names: new Set(), complete: true });
    } else if ((dir === '' || wanted.has(dir)) && budget.left > 0) {
      budget.left -= 1;
      targets.push(dir);
    }
  }
  return targets;
}

async function probeDir(
  dir: string,
  io: ConflictProbeIo,
  known: Map<string, KnownDir>
): Promise<void> {
  const probe = await io.list(dir).catch((): DirProbe => 'unknown');
  if (probe === 'unknown') return;
  if (probe === 'missing') known.set(dir, { names: new Set(), complete: true });
  else known.set(dir, { names: new Set(probe.names), complete: !probe.truncated });
}

// 截断的列表里找不到名字不代表不存在：对这些文件逐个确认，否则大目录里会静默覆盖。
async function confirmTruncated(
  wanted: ReadonlyMap<string, string[]>,
  known: ReadonlyMap<string, KnownDir>,
  io: ConflictProbeIo,
  budget: ProbeBudget
): Promise<void> {
  for (const [dir, names] of wanted) {
    const state = known.get(dir);
    if (!state || state.complete) continue;
    const unsure = names.filter((name) => !state.names.has(name)).slice(0, budget.left);
    budget.left -= unsure.length;
    await inChunks(unsure, async (name) => {
      const found = await io.exists(dir, name).catch(() => false);
      if (found) state.names.add(name);
    });
  }
}

/** 查出每个「有文件要落进去」的目录里已存在的名称；没查到的目录给空集。 */
export async function probeExistingNames(
  plan: Pick<FolderUploadPlan, 'files' | 'dirs'>,
  io: ConflictProbeIo
): Promise<Map<string, ReadonlySet<string>>> {
  const wanted = namesByDir(plan.files);
  const known = new Map<string, KnownDir>();
  const budget: ProbeBudget = { left: io.limit ?? UPLOAD_CONFLICT_PROBE_LIMIT };
  for (const level of levelsOf(['', ...plan.dirs, ...wanted.keys()])) {
    const targets = pickProbeTargets(level, wanted, known, budget);
    await inChunks(targets, (dir) => probeDir(dir, io, known));
  }
  await confirmTruncated(wanted, known, io, budget);
  const result = new Map<string, ReadonlySet<string>>();
  for (const dir of wanted.keys()) result.set(dir, known.get(dir)?.names ?? new Set());
  return result;
}
