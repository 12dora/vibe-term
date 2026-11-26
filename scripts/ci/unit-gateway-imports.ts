// gateway 的 src 一级目录各自独立成测试进程：某目录的文件被其他目录导入时，
// 改动要连带那些目录。这里对 apps/gateway/src 做廉价的反向相对导入扫描（正则，不解析 AST）。
import { posix } from 'node:path';
import { loadSources, relativeImports } from './unit-imports';

const GATEWAY_SRC = 'apps/gateway/src';

function resolveImport(
  importer: string,
  spec: string,
  known: ReadonlySet<string>
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(importer), spec)).replace(/\/$/, '');
  const stem = base.replace(/\.[mc]?jsx?$/, '');
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${stem}.ts`,
    `${stem}.tsx`,
  ].find((candidate) => known.has(candidate));
}

function reverseImports(
  sources: ReadonlyMap<string, string>,
  known: ReadonlySet<string>
): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const [file, content] of sources) {
    for (const spec of relativeImports(content)) {
      const target = resolveImport(file, spec, known);
      if (target) importers.set(target, [...(importers.get(target) ?? []), file]);
    }
  }
  return importers;
}

// 改动文件及其（传递）导入者 → 最初引发它的改动文件。已删除的改动文件仍按路径参与解析。
export function affectedFiles(
  sources: ReadonlyMap<string, string>,
  changed: readonly string[]
): Map<string, string> {
  const known = new Set([...sources.keys(), ...changed]);
  const importers = reverseImports(sources, known);
  const origin = new Map<string, string>();
  const queue: string[] = [];
  for (const file of changed) {
    if (origin.has(file)) continue;
    origin.set(file, file);
    queue.push(file);
  }
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const importer of importers.get(cur) ?? []) {
      if (origin.has(importer)) continue;
      origin.set(importer, origin.get(cur) ?? cur);
      queue.push(importer);
    }
  }
  return origin;
}

export function loadGatewaySources(root: string): Map<string, string> {
  return loadSources(root, GATEWAY_SRC);
}
