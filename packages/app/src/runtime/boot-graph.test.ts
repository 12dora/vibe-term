import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const ENTRY = 'packages/app/src/runtime/server.ts';

// 空闲节点（全新安装 / 加入中继的 mesh 节点、无 SSH 设备、未配 ACME、未用直连）启动时不该求值的模块
const LAZY_ONLY = [
  'packages/app/src/i18n/en.ts',
  'packages/app/src/i18n/zh-cn.ts',
  'packages/app/src/cli/help.ts',
  'apps/gateway/src/tmux-client/ssh-external-connection.ts',
  'apps/gateway/src/tmux-client/ssh-auth-resolvers.ts',
  'packages/app/src/tls/acme-service.ts',
  'apps/gateway/src/mesh/rtc/ice.ts',
  'apps/gateway/src/mesh/rtc/stun-resolver.ts',
  'apps/gateway/src/mesh/rtc/stun-probe.ts',
  'apps/gateway/src/mesh/rtc/turn-probe.ts',
  'apps/gateway/src/mesh/rtc/stun-effective.ts',
  'apps/gateway/src/mesh/rtc/rtc-peer-helpers.ts',
  'apps/gateway/src/mesh/rtc/browser-authorize.ts',
  'apps/gateway/src/system/upgrade.ts',
  'apps/gateway/src/system/release-download.ts',
  'apps/gateway/src/system/remote-upgrade-io.ts',
  'apps/gateway/src/mesh/relay-routes.ts',
  'apps/gateway/src/relay/relay-routes.ts',
  'apps/gateway/src/mesh/uplink-pool.ts',
  'apps/gateway/src/mesh/relay-uplink-client.ts',
];

const STATIC_EDGE =
  /^\s*(?:import|export)\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gms;

type Exports = Record<string, string | Record<string, string>>;
type WorkspacePackage = { dir: string; exports: Exports };

function workspacePackages(): Map<string, WorkspacePackage> {
  const out = new Map<string, WorkspacePackage>();
  for (const base of ['apps', 'packages']) {
    for (const name of readdirSync(join(REPO_ROOT, base))) {
      const pkgPath = join(REPO_ROOT, base, name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name: string;
        exports?: Exports | string;
      };
      const exports = typeof pkg.exports === 'string' ? { '.': pkg.exports } : (pkg.exports ?? {});
      out.set(pkg.name, { dir: join(base, name), exports });
    }
  }
  return out;
}

function isFile(rel: string): boolean {
  const abs = join(REPO_ROOT, rel);
  return existsSync(abs) && statSync(abs).isFile();
}

function resolveFile(rel: string): string | null {
  const base = rel.endsWith('.js') ? rel.slice(0, -3) : rel;
  for (const candidate of [rel, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (isFile(candidate)) return normalize(candidate);
  }
  return null;
}

function exportTarget(entry: string | Record<string, string> | undefined): string | undefined {
  if (typeof entry === 'string' || entry === undefined) return entry;
  return entry.bun ?? entry.import ?? entry.default;
}

function resolveSpecifier(
  spec: string,
  from: string,
  pkgs: Map<string, WorkspacePackage>
): string | null {
  if (spec.startsWith('.')) return resolveFile(join(dirname(from), spec));
  for (const [name, pkg] of pkgs) {
    if (spec !== name && !spec.startsWith(`${name}/`)) continue;
    const target = exportTarget(pkg.exports[`.${spec.slice(name.length)}`]);
    if (target) return resolveFile(join(pkg.dir, target));
    return resolveFile(join(pkg.dir, 'src', spec.slice(name.length + 1)));
  }
  return null;
}

function isTypeOnlyClause(clause: string): boolean {
  const named = clause.match(/^\{([^}]*)\}$/s);
  if (!named?.[1]) return false;
  const names = named[1]
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((part) => part.startsWith('type '));
}

function staticEdges(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(STATIC_EDGE)) {
    const clause = match[1]?.trim();
    if (clause !== undefined && isTypeOnlyClause(clause)) continue;
    const spec = match[2] ?? match[3];
    if (spec) out.push(spec);
  }
  return out;
}

function bootReachable(): Set<string> {
  const pkgs = workspacePackages();
  const seen = new Set<string>([ENTRY]);
  const stack = [ENTRY];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    for (const spec of staticEdges(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
      const target = resolveSpecifier(spec, file, pkgs);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      stack.push(target);
    }
  }
  return seen;
}

describe('runtime boot import graph', () => {
  test('edge pattern skips type-only, dynamic and require imports', () => {
    const src = [
      "import { a } from './a';",
      "import type { B } from './b';",
      "import { type C, type D } from './c';",
      "import { type E, f } from './e';",
      "export { g } from './g';",
      "export type { H } from './h';",
      "import './side';",
      "const lazy = () => import('./lazy');",
      "const sync = require('./sync');",
    ].join('\n');
    expect(staticEdges(src)).toEqual(['./a', './e', './g', './side']);
  });

  test('core runtime modules stay reachable (walker sanity)', () => {
    const reach = bootReachable();
    expect(reach.has('apps/gateway/src/runtime.ts')).toBe(true);
    expect(reach.has('packages/app/src/i18n/en-runtime.ts')).toBe(true);
    expect(reach.has('packages/app/src/tls/renewal-scheduler.ts')).toBe(true);
  });

  test('CLI strings, SSH, ACME, WebRTC/STUN, upgrade and relay stacks load lazily', () => {
    const reach = bootReachable();
    const offenders = LAZY_ONLY.filter((rel) => reach.has(rel));
    expect(offenders).toEqual([]);
  });
});
