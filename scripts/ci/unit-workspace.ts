// workspace 依赖图：从各 package.json 的 dependencies / devDependencies / peerDependencies 中
// 取出指向其他 workspace 包的条目，据此求「改动包 → 传递依赖它的包」。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
  // 包目录 → 直接依赖它的包目录
  dependents: Map<string, string[]>;
};

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;

export function buildWorkspace(
  entries: ReadonlyArray<{ dir: string; pkg: PackageJson }>
): Workspace {
  const dirByName = new Map<string, string>();
  for (const { dir, pkg } of entries) if (pkg.name) dirByName.set(pkg.name, dir);
  const dependents = new Map<string, string[]>(entries.map((e) => [e.dir, []]));
  for (const { dir, pkg } of entries) {
    const names = new Set(DEP_FIELDS.flatMap((field) => Object.keys(pkg[field] ?? {})));
    for (const name of names) {
      const dep = dirByName.get(name);
      if (dep && dep !== dir) dependents.get(dep)?.push(dir);
    }
  }
  return { dirs: entries.map((e) => e.dir), dependents };
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

export function loadWorkspace(root: string): Workspace {
  const read = (dir: string) =>
    JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as PackageJson;
  const patterns = read('.').workspaces ?? [];
  return buildWorkspace(workspaceDirs(root, patterns).map((dir) => ({ dir, pkg: read(dir) })));
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
export function dependentChains(ws: Workspace, from: string): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const seen = new Set([from]);
  const queue: string[][] = [[from]];
  for (let i = 0; i < queue.length; i++) {
    const chain = queue[i];
    for (const dep of ws.dependents.get(chain[chain.length - 1]) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const next = [...chain, dep];
      chains.set(dep, next);
      queue.push(next);
    }
  }
  return chains;
}
