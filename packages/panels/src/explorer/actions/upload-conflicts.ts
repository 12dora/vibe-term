// 上传前的同名冲突检查：每个文件的落点是「已存在（会被覆盖）」「确定不存在」还是「没查清」。
// 没查清的绝不能当成干净的——网关落盘是 rename 覆盖，猜错就是静默丢文件。
// 目录列表怎么取由调用方注入，这里只负责「查哪些目录」与「怎么判」。

import type { FolderUploadFile, FolderUploadPlan } from './folder-upload';

/** 一次上传最多探测这么多次（列目录 + 截断目录下的逐个 stat）；没轮到的一律算「没查清」 */
export const UPLOAD_CONFLICT_PROBE_LIMIT = 200;

/** 截断的列表里缺的候选名超过这个数就不逐个 stat 了，直接算「没查清」，把预算留给别的目录 */
export const UPLOAD_CONFLICT_STAT_THRESHOLD = 20;

const PROBE_CONCURRENCY = 6;

/** 一个目录里已查明的事实 */
export interface DirExistence {
  /** 确定已存在的名称 */
  existing: ReadonlySet<string>;
  /** 确定不存在的名称；`'all'` = 不在 `existing` 里的都不存在（列表完整，或目录本身不存在） */
  absent: ReadonlySet<string> | 'all';
}

/** 键是相对目标目录的目录路径（'' = 目标目录自身）；没有条目 = 这个目录什么都没查清 */
export type ExistenceByDir = ReadonlyMap<string, DirExistence>;

export interface UploadConflictPlan {
  /** 落点已存在 */
  conflicts: FolderUploadFile[];
  /** 落点确定不存在 */
  clean: FolderUploadFile[];
  /** 没查清（预算用完、探测失败、列表被截断）：与冲突一起交给用户决定 */
  unknown: FolderUploadFile[];
}

export type UploadConflictChoice = 'cancel' | 'skip' | 'replace';

function classify(
  item: FolderUploadFile,
  existenceByDir: ExistenceByDir
): keyof UploadConflictPlan {
  const facts = existenceByDir.get(item.relDir);
  if (!facts) return 'unknown';
  if (facts.existing.has(item.file.name)) return 'conflicts';
  if (facts.absent === 'all' || facts.absent.has(item.file.name)) return 'clean';
  return 'unknown';
}

export function planUploadConflicts(
  files: readonly FolderUploadFile[],
  existenceByDir: ExistenceByDir
): UploadConflictPlan {
  const plan: UploadConflictPlan = { conflicts: [], clean: [], unknown: [] };
  for (const item of files) plan[classify(item, existenceByDir)].push(item);
  return plan;
}

/** 提示里展示的名称：带上相对目录，便于分辨不同子目录里的同名文件 */
export function conflictDisplayName(item: FolderUploadFile): string {
  return item.relDir ? `${item.relDir}/${item.file.name}` : item.file.name;
}

/** 需要用户决定的项目：确定冲突的排前面，没查清的跟在后面；为空则不必询问 */
export function conflictPromptNames(plan: UploadConflictPlan): string[] {
  return [...plan.conflicts, ...plan.unknown].map(conflictDisplayName);
}

/** 用户选择之后真正要传的文件：取消 → null；跳过 → 只传确定不存在的；替换 → 全部。 */
export function selectUploadFiles(
  all: readonly FolderUploadFile[],
  plan: UploadConflictPlan,
  choice: UploadConflictChoice
): FolderUploadFile[] | null {
  if (choice === 'cancel') return null;
  return choice === 'skip' ? plan.clean : [...all];
}

/** `missing` = 目录不存在（其下必然无冲突）；`unknown` = 没查到（网络、权限等） */
export type DirProbe = { names: readonly string[]; truncated: boolean } | 'missing' | 'unknown';

export interface ConflictProbeIo {
  list(relDir: string): Promise<DirProbe>;
  /** 列表被截断时逐个确认：true 存在、false 确定不存在；查不清就 reject */
  exists(relDir: string, name: string): Promise<boolean>;
  limit?: number;
}

interface DirFacts {
  existing: Set<string>;
  absent: Set<string> | 'all';
}

/** `'failed'` = 列表没取到：它和它下面的目录都不再探测，其中的文件全算没查清 */
type DirState = DirFacts | 'failed';

interface ProbeBudget {
  left: number;
}

function missingDir(): DirFacts {
  return { existing: new Set(), absent: 'all' };
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

// 不必发请求就能下结论的两种情况：父目录没取到 → 跟着算失败；
// 父目录的完整列表里没有它 → 它不存在。其余返回 null，需要自己去查。
function inheritedState(dir: string, known: ReadonlyMap<string, DirState>): DirState | null {
  if (dir === '') return null;
  const { parent, name } = splitRel(dir);
  const parentState = known.get(parent);
  if (parentState === undefined) return null;
  if (parentState === 'failed') return 'failed';
  return parentState.absent === 'all' && !parentState.existing.has(name) ? missingDir() : null;
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
  known: Map<string, DirState>,
  budget: ProbeBudget
): string[] {
  const targets: string[] = [];
  for (const dir of level) {
    const inherited = inheritedState(dir, known);
    if (inherited) {
      known.set(dir, inherited);
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
  known: Map<string, DirState>
): Promise<void> {
  const probe = await io.list(dir).catch((): DirProbe => 'unknown');
  if (probe === 'unknown') {
    known.set(dir, 'failed');
  } else if (probe === 'missing') {
    known.set(dir, missingDir());
  } else {
    const absent: DirFacts['absent'] = probe.truncated ? new Set() : 'all';
    known.set(dir, { existing: new Set(probe.names), absent });
  }
}

async function confirmName(
  dir: string,
  name: string,
  facts: DirFacts,
  io: ConflictProbeIo
): Promise<void> {
  if (facts.absent === 'all') return;
  try {
    if (await io.exists(dir, name)) facts.existing.add(name);
    else facts.absent.add(name);
  } catch {
    // 没查清就保持未知，交给用户决定
  }
}

// 截断的列表里找不到名字不代表不存在。缺的不多就逐个 stat 确认；缺得多（或预算不够全部确认）
// 就整批留作未知——零散地确认一部分只会把预算耗光，剩下的照样未知。
async function confirmTruncated(
  wanted: ReadonlyMap<string, string[]>,
  known: ReadonlyMap<string, DirState>,
  io: ConflictProbeIo,
  budget: ProbeBudget
): Promise<void> {
  for (const [dir, names] of wanted) {
    const facts = known.get(dir);
    if (!facts || facts === 'failed' || facts.absent === 'all') continue;
    const unsure = Array.from(new Set(names)).filter((name) => !facts.existing.has(name));
    if (unsure.length > UPLOAD_CONFLICT_STAT_THRESHOLD || unsure.length > budget.left) continue;
    budget.left -= unsure.length;
    await inChunks(unsure, (name) => confirmName(dir, name, facts, io));
  }
}

/**
 * 查出每个「有文件要落进去」的目录里已查明的事实。
 * 结果里没有的目录（预算没轮到、列表没取到）一律视为没查清。
 */
export async function probeExistence(
  plan: Pick<FolderUploadPlan, 'files' | 'dirs'>,
  io: ConflictProbeIo
): Promise<Map<string, DirExistence>> {
  const wanted = namesByDir(plan.files);
  const known = new Map<string, DirState>();
  const budget: ProbeBudget = { left: io.limit ?? UPLOAD_CONFLICT_PROBE_LIMIT };
  for (const level of levelsOf(['', ...plan.dirs, ...wanted.keys()])) {
    const targets = pickProbeTargets(level, wanted, known, budget);
    await inChunks(targets, (dir) => probeDir(dir, io, known));
  }
  await confirmTruncated(wanted, known, io, budget);
  const result = new Map<string, DirExistence>();
  for (const dir of wanted.keys()) {
    const state = known.get(dir);
    if (state && state !== 'failed') result.set(dir, state);
  }
  return result;
}
