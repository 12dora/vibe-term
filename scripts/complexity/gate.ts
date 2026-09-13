// 复杂度门禁：CC / 函数行数 / 文件行数 / 参数个数 / 嵌套深度 / 跨文件重复。
// 有意保留的热点写进 allowlist.json（键为 "相对路径" 或 "相对路径:函数名"），
// 门禁对这些条目只要求不继续恶化（不高于记录值）。
// 故意同构的文件对写进 duplication-allowlist.json。
// 用法：bun scripts/complexity/gate.ts [--report|--tighten]
//   --report  打印各指标计数与 top-10，不判定失败
//   --tighten 按当前实测值收紧 allowlist（只降不升；回到默认阈值内的字段/条目删除；
//             新阈值下已有超标写入冻结条目）
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type DupAllowEntry,
  type DupHit,
  findDuplication,
  formatDupHit,
  isDupAllowed,
} from './duplication';
import {
  type AllowMap,
  FILE_WARN_LINES,
  type FnMetrics,
  LIMITS,
  analyzeSource,
  fnKey,
  tightenAllowlist,
} from './metrics';

export { LIMITS, FILE_WARN_LINES } from './metrics';
export { DUP_WINDOW, findDuplication, formatDupHit, isDupAllowed } from './duplication';
export { analyzeSource, tightenAllowlist } from './metrics';

const ROOT = join(import.meta.dir, '..', '..');
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'fe-dist',
  '.git',
  'resources',
  'docs',
  'bench',
  'scripts',
]);
const SKIP_FILE = /\.test\.|\.spec\.|\.integration\.|\.bench\.|\.d\.ts$/;
const SKIP_PATH = /\/i18n\/(resources|types)\.ts$|\/vendor\/|\/tests\//;

export type GateIssueSet = {
  violations: string[];
  warnings: string[];
  stale: string[];
};

export type GateCounts = {
  cc: number;
  fnLines: number;
  fileLines: number;
  params: number;
  nesting: number;
  duplication: number;
};

export function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !SKIP_FILE.test(entry) && !SKIP_PATH.test(path))
      out.push(path);
  }
}

export function collectFiles(root: string): string[] {
  const files: string[] = [];
  for (const top of ['apps', 'packages']) {
    const dir = join(root, top);
    if (existsSync(dir)) walk(dir, files);
  }
  return files;
}

export function loadAllow(path: string): AllowMap {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as AllowMap) : {};
}

export function loadDupAllow(path: string): DupAllowEntry[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as DupAllowEntry[]) : [];
}

export function collectIssues(args: {
  fns: FnMetrics[];
  fileLines: Map<string, number>;
  allow: AllowMap;
  dups: DupHit[];
  dupAllow: DupAllowEntry[];
}): GateIssueSet & { usedAllow: Set<string> } {
  const violations: string[] = [];
  const warnings: string[] = [];
  const usedAllow = new Set<string>();

  for (const [rel, lines] of args.fileLines) {
    const fileAllow = args.allow[rel];
    if (fileAllow) usedAllow.add(rel);
    const fileLimit = fileAllow?.fileLines ?? LIMITS.fileLines;
    if (lines > fileLimit) violations.push(`${rel}: ${lines} lines > ${fileLimit}`);
    else if (!fileAllow && lines >= FILE_WARN_LINES)
      warnings.push(`${rel}: ${lines} lines (limit ${LIMITS.fileLines})`);
  }

  for (const fn of args.fns) {
    const key = fnKey(fn.file, fn.name);
    const entry = args.allow[key];
    if (entry) usedAllow.add(key);
    const ccLimit = entry?.cc ?? LIMITS.cc;
    const lineLimit = entry?.lines ?? LIMITS.fnLines;
    const paramLimit = entry?.params ?? LIMITS.params;
    const nestLimit = entry?.nesting ?? LIMITS.nesting;
    if (fn.cc > ccLimit)
      violations.push(`${fn.file}:${fn.line} ${fn.name}: CC ${fn.cc} > ${ccLimit}`);
    if (fn.lines > lineLimit)
      violations.push(`${fn.file}:${fn.line} ${fn.name}: ${fn.lines} lines > ${lineLimit}`);
    if (fn.params > paramLimit)
      violations.push(`${fn.file}:${fn.line} ${fn.name}: ${fn.params} params > ${paramLimit}`);
    if (fn.nesting > nestLimit)
      violations.push(`${fn.file}:${fn.line} ${fn.name}: nesting ${fn.nesting} > ${nestLimit}`);
  }

  for (const hit of args.dups) {
    if (isDupAllowed(hit, args.dupAllow)) continue;
    violations.push(formatDupHit(hit));
  }

  const stale = Object.keys(args.allow).filter((k) => !usedAllow.has(k));
  return { violations, warnings, stale, usedAllow };
}

export function countOverLimit(
  fns: FnMetrics[],
  fileLines: Map<string, number>,
  dups: DupHit[]
): GateCounts {
  return {
    cc: fns.filter((f) => f.cc > LIMITS.cc).length,
    fnLines: fns.filter((f) => f.lines > LIMITS.fnLines).length,
    fileLines: [...fileLines.values()].filter((n) => n > LIMITS.fileLines).length,
    params: fns.filter((f) => f.params > LIMITS.params).length,
    nesting: fns.filter((f) => f.nesting > LIMITS.nesting).length,
    duplication: dups.length,
  };
}

export function formatReport(args: {
  files: number;
  fns: FnMetrics[];
  fileLines: Map<string, number>;
  dups: DupHit[];
}): string {
  const counts = countOverLimit(args.fns, args.fileLines, args.dups);
  const topCc = [...args.fns].sort((a, b) => b.cc - a.cc || b.lines - a.lines).slice(0, 10);
  const topFn = [...args.fns].sort((a, b) => b.lines - a.lines || b.cc - a.cc).slice(0, 10);
  const topFile = [...args.fileLines.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10);
  const topParams = [...args.fns].sort((a, b) => b.params - a.params || b.cc - a.cc).slice(0, 10);
  const topNest = [...args.fns].sort((a, b) => b.nesting - a.nesting || b.cc - a.cc).slice(0, 10);
  const topDup = [...args.dups].sort((a, b) => b.lines - a.lines).slice(0, 10);

  const lines: string[] = [
    `files ${args.files}, functions ${args.fns.length}`,
    `CC>${LIMITS.cc}: ${counts.cc}`,
    `fn>${LIMITS.fnLines}: ${counts.fnLines}`,
    `file>${LIMITS.fileLines}: ${counts.fileLines}`,
    `params>${LIMITS.params}: ${counts.params}`,
    `nesting>${LIMITS.nesting}: ${counts.nesting}`,
    `duplication: ${counts.duplication}`,
    'top CC:',
    ...topCc.map((f) => `  ${f.cc}\t${f.lines}L\t${f.file}:${f.line}\t${f.name}`),
    'top fn lines:',
    ...topFn.map((f) => `  ${f.lines}L\tCC${f.cc}\t${f.file}:${f.line}\t${f.name}`),
    'top files:',
    ...topFile.map(([file, n]) => `  ${n}L\t${file}`),
    'top params:',
    ...topParams.map((f) => `  ${f.params}\t${f.file}:${f.line}\t${f.name}`),
    'top nesting:',
    ...topNest.map((f) => `  ${f.nesting}\t${f.file}:${f.line}\t${f.name}`),
    'top duplication:',
    ...topDup.map((h) => `  ${formatDupHit(h)}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function scanRoot(root: string): {
  files: string[];
  fns: FnMetrics[];
  fileLines: Map<string, number>;
  texts: Array<{ rel: string; text: string }>;
} {
  const files = collectFiles(root);
  const fns: FnMetrics[] = [];
  const fileLines = new Map<string, number>();
  const texts: Array<{ rel: string; text: string }> = [];
  for (const abs of files) {
    const text = readFileSync(abs, 'utf8');
    const rel = relative(root, abs);
    texts.push({ rel, text });
    const analyzed = analyzeSource(text, rel);
    fns.push(...analyzed.fns);
    fileLines.set(rel, analyzed.lines);
  }
  return { files, fns, fileLines, texts };
}

export function main(argv: string[], root = ROOT): number {
  const allowPath = join(import.meta.dir, 'allowlist.json');
  const dupAllowPath = join(import.meta.dir, 'duplication-allowlist.json');
  const { files, fns, fileLines, texts } = scanRoot(root);
  const allow = loadAllow(allowPath);
  const dupAllow = loadDupAllow(dupAllowPath);
  const dups = findDuplication(texts);

  if (argv.includes('--tighten')) {
    const next = tightenAllowlist(allow, fns, fileLines);
    writeFileSync(allowPath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `allowlist tightened: ${Object.keys(allow).length} -> ${Object.keys(next).length} entries`
    );
    return 0;
  }

  if (argv.includes('--report')) {
    process.stdout.write(formatReport({ files: files.length, fns, fileLines, dups }));
    return 0;
  }

  const { violations, warnings, stale } = collectIssues({ fns, fileLines, allow, dups, dupAllow });
  for (const w of warnings) console.warn(`complexity near limit: ${w}`);
  for (const v of violations) console.error(`complexity: ${v}`);
  for (const k of stale)
    console.error(`complexity: allowlist entry no longer matches anything: ${k}`);
  if (violations.length > 0 || stale.length > 0) {
    console.error(
      `complexity gate failed: ${violations.length} violation(s), ${stale.length} stale allowlist entr(y/ies)`
    );
    return 1;
  }
  console.log(`complexity gate ok (${files.length} files, ${fns.length} functions)`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
