// 复杂度门禁：McCabe 圈复杂度 / 函数行数 / 文件行数 三条阈值，超标即失败。
// 有意保留的热点写进 allowlist.json（键为 "相对路径:函数名"，值为保留理由），
// 门禁对这些条目只要求不继续恶化（不高于记录的 cc / lines）。
// 用法：bun scripts/complexity/gate.ts [--report|--tighten]
//   --report  只打印排行，不判定失败
//   --tighten 按当前实测值收紧 allowlist（只降不升；降回默认阈值内的字段/条目直接删除，失配条目剔除）
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dir, '..', '..');
const LIMITS = { cc: 15, fnLines: 120, fileLines: 900 };
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'fe-dist',
  '.git',
  'resources',
  'prompt-archives',
  'docs',
  'bench',
  'scripts',
]);
const SKIP_FILE = /\.test\.|\.spec\.|\.integration\.|\.bench\.|\.d\.ts$/;
const SKIP_PATH = /\/i18n\/(resources|types)\.ts$|\/vendor\/|\/tests\//;

type Fn = { file: string; name: string; line: number; cc: number; lines: number };
type Allow = Record<string, { cc?: number; lines?: number; fileLines?: number; reason: string }>;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !SKIP_FILE.test(entry) && !SKIP_PATH.test(path))
      out.push(path);
  }
}

function cyclomatic(fn: ts.Node): number {
  let cc = 1;
  const visit = (n: ts.Node): void => {
    if (n !== fn && isFunctionLike(n)) return;
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        cc++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = (n as ts.BinaryExpression).operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        )
          cc++;
        break;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return cc;
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  );
}

function functionName(n: ts.Node): string | null {
  if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n))
    return n.name?.getText() ?? '<anon>';
  if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.parent) {
    if (ts.isVariableDeclaration(n.parent)) return n.parent.name.getText();
    if (ts.isPropertyAssignment(n.parent)) return n.parent.name.getText();
    if (n.body && ts.isBlock(n.body) && n.body.statements.length > 15) return '<anon>';
  }
  return null;
}

function analyze(file: string): { fns: Fn[]; lines: number } {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const rel = relative(ROOT, file);
  const fns: Fn[] = [];
  const visit = (n: ts.Node): void => {
    const name = isFunctionLike(n) ? functionName(n) : null;
    if (name !== null) {
      const start = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
      fns.push({ file: rel, name, line: start, cc: cyclomatic(n), lines: end - start + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { fns, lines: text.split('\n').length };
}

const allowPath = join(import.meta.dir, 'allowlist.json');
const allow: Allow = existsSync(allowPath) ? JSON.parse(readFileSync(allowPath, 'utf8')) : {};
const files: string[] = [];
for (const top of ['apps', 'packages']) walk(join(ROOT, top), files);

const all: Fn[] = [];
const violations: string[] = [];
const usedAllow = new Set<string>();
const fileLineCounts = new Map<string, number>();
for (const file of files) {
  const { fns, lines } = analyze(file);
  all.push(...fns);
  const rel = relative(ROOT, file);
  fileLineCounts.set(rel, lines);
  const fileAllow = allow[rel];
  if (fileAllow) usedAllow.add(rel);
  const fileLimit = fileAllow?.fileLines ?? LIMITS.fileLines;
  if (lines > fileLimit) violations.push(`${rel}: ${lines} lines > ${fileLimit}`);
  for (const fn of fns) {
    const key = `${rel}:${fn.name}`;
    const entry = allow[key];
    if (entry) usedAllow.add(key);
    const ccLimit = entry?.cc ?? LIMITS.cc;
    const lineLimit = entry?.lines ?? LIMITS.fnLines;
    if (fn.cc > ccLimit) violations.push(`${rel}:${fn.line} ${fn.name}: CC ${fn.cc} > ${ccLimit}`);
    if (fn.lines > lineLimit)
      violations.push(`${rel}:${fn.line} ${fn.name}: ${fn.lines} lines > ${lineLimit}`);
  }
}
const stale = Object.keys(allow).filter((k) => !usedAllow.has(k));

if (process.argv.includes('--tighten')) {
  // 同名函数取最大实测值（gate 判定对每个同 key 函数都生效，锁值必须覆盖最大者）
  const maxCc = new Map<string, number>();
  const maxLines = new Map<string, number>();
  for (const fn of all) {
    const key = `${fn.file}:${fn.name}`;
    maxCc.set(key, Math.max(maxCc.get(key) ?? 0, fn.cc));
    maxLines.set(key, Math.max(maxLines.get(key) ?? 0, fn.lines));
  }
  const next: Allow = {};
  for (const [key, entry] of Object.entries(allow)) {
    if (stale.includes(key)) continue;
    const updated = { ...entry };
    if (entry.fileLines !== undefined) {
      const cur = fileLineCounts.get(key) ?? 0;
      if (cur > LIMITS.fileLines) updated.fileLines = Math.min(entry.fileLines, cur);
      else updated.fileLines = undefined;
    }
    if (entry.cc !== undefined) {
      const cur = maxCc.get(key) ?? 0;
      if (cur > LIMITS.cc) updated.cc = Math.min(entry.cc, cur);
      else updated.cc = undefined;
    }
    if (entry.lines !== undefined) {
      const cur = maxLines.get(key) ?? 0;
      if (cur > LIMITS.fnLines) updated.lines = Math.min(entry.lines, cur);
      else updated.lines = undefined;
    }
    if (
      updated.cc !== undefined ||
      updated.lines !== undefined ||
      updated.fileLines !== undefined
    ) {
      next[key] = updated;
    }
  }
  writeFileSync(allowPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `allowlist tightened: ${Object.keys(allow).length} -> ${Object.keys(next).length} entries`
  );
  process.exit(0);
}

if (process.argv.includes('--report')) {
  const byCc = [...all].sort((a, b) => b.cc - a.cc).slice(0, 30);
  console.log(
    `files ${files.length}, functions ${all.length}, CC>${LIMITS.cc}: ${all.filter((f) => f.cc > LIMITS.cc).length}, >${LIMITS.fnLines} lines: ${all.filter((f) => f.lines > LIMITS.fnLines).length}`
  );
  for (const f of byCc) console.log(`${f.cc}\t${f.lines}L\t${f.file}:${f.line}\t${f.name}`);
  process.exit(0);
}
for (const v of violations) console.error(`complexity: ${v}`);
for (const k of stale)
  console.error(`complexity: allowlist entry no longer matches anything: ${k}`);
if (violations.length > 0 || stale.length > 0) {
  console.error(
    `complexity gate failed: ${violations.length} violation(s), ${stale.length} stale allowlist entr(y/ies)`
  );
  process.exit(1);
}
console.log(`complexity gate ok (${files.length} files, ${all.length} functions)`);
