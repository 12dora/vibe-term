// workspace 依赖图，据此求「改动包 → 传递依赖它的包」。边有两个来源：
//   1. 各 package.json 的 dependencies / devDependencies / peerDependencies 中指向其他 workspace 包的条目；
//   2. 源码里跨包的相对导入（如 packages/app 直接导入 packages/shared/src），它们不会声明在 package.json。
// 仅由测试文件产生的相对导入只影响导入方自己的测试，不再向它的依赖者传递。
// 节点除 workspace 包外，还可加入仓库根下按目录划分的测试目标（如 scripts/release）。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { loadSources, relativeImports } from './unit-imports';
import { isPathUnder } from './unit-paths';

export type PackageJson = {
  name?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type Workspace = {
  dirs: string[];
  // 包目录 → 直接依赖它的包目录（package.json 依赖与非测试源码的相对导入，沿此传递）
  dependents: Map<string, string[]>;
  // 包目录 → 仅其测试文件相对导入它的包目录（只算一跳）
  testDependents: Map<string, string[]>;
};

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

const TEST_FILE = /\.test\.tsx?$/;

function addDependent(edges: Map<string, string[]>, dep: string, dependent: string): void {
  const list = edges.get(dep);
  if (list && !list.includes(dependent)) list.push(dependent);
}

// sources：节点内的源码（路径 → 内容），用于补充跨包相对导入产生的边。
export function buildWorkspace(
  entries: ReadonlyArray<{ dir: string; pkg: PackageJson }>,
  sources: ReadonlyMap<string, string> = new Map()
): Workspace {
  const dirByName = new Map<string, string>();
  for (const { dir, pkg } of entries) if (pkg.name) dirByName.set(pkg.name, dir);
  const noEdges = () => new Map<string, string[]>(entries.map((e) => [e.dir, []]));
  const ws: Workspace = {
    dirs: entries.map((e) => e.dir),
    dependents: noEdges(),
    testDependents: noEdges(),
  };
  for (const { dir, pkg } of entries) {
    const names = new Set(DEP_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})));
    for (const name of names) {
      const dep = dirByName.get(name);
      if (dep && dep !== dir) addDependent(ws.dependents, dep, dir);
    }
  }
  for (const [file, content] of sources) {
    const importer = ownerOf(ws, file);
    if (!importer) continue;
    for (const spec of relativeImports(content)) {
      const dep = ownerOf(ws, posix.join(posix.dirname(file), spec));
      if (!dep || dep === importer) continue;
      addDependent(TEST_FILE.test(file) ? ws.testDependents : ws.dependents, dep, importer);
    }
  }
  return ws;
}

function workspaceDirs(root: string, patterns: readonly string[]): string[] {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      dirs.push(pattern);
      continue;
    }
    const base = pattern.slice(0, -2);
    if (!existsSync(join(root, base))) continue;
    for (const entry of readdirSync(join(root, base)).sort()) dirs.push(`${base}/${entry}`);
  }
  return dirs.filter((dir) => existsSync(join(root, dir, 'package.json')));
}

// extraDirs：不是 workspace 包、但要作为图节点的目录（如仓库根下的测试目标目录）。
export function loadWorkspace(root: string, extraDirs: readonly string[] = []): Workspace {
  const read = (dir: string) =>
    JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as PackageJson;
  const patterns = read('.').workspaces ?? [];
  const entries = [
    ...workspaceDirs(root, patterns).map((dir) => ({ dir, pkg: read(dir) })),
    ...extraDirs.filter((dir) => existsSync(join(root, dir))).map((dir) => ({ dir, pkg: {} })),
  ];
  const sources = new Map<string, string>();
  for (const { dir } of entries) {
    for (const [file, content] of loadSources(root, dir)) sources.set(file, content);
  }
  return buildWorkspace(entries, sources);
}

// 文件所属的 workspace 包（取最长目录前缀）；不属于任何包返回 undefined。
export function ownerOf(ws: Workspace, file: string): string | undefined {
  let best: string | undefined;
  for (const dir of ws.dirs) {
    if (isPathUnder(file, dir) && (!best || dir.length > best.length)) best = dir;
  }
  return best;
}

// 从 `from` 出发沿依赖反向广度优先：每个（传递）依赖者 → 最短依赖链 [from, …, 依赖者]。不含 from 自身。
// 仅测试导入的依赖者作为叶子加入，不再继续传递。
export function dependentChains(ws: Workspace, from: string): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const seen = new Set([from]);
  const visit = (queue: string[][], expand: boolean, edges: Map<string, string[]>) => {
    for (let i = 0; i < queue.length; i++) {
      const chain = queue[i];
      for (const dep of edges.get(chain[chain.length - 1]) ?? []) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        const next = [...chain, dep];
        chains.set(dep, next);
        if (expand) queue.push(next);
      }
    }
  };
  const reached: string[][] = [[from]];
  visit(reached, true, ws.dependents);
  visit(reached, false, ws.testDependents);
  return chains;
}
