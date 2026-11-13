import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FULL,
  TARGETS,
  type TestTarget,
  loadSharedConsumers,
  packageDependsOnShared,
  selectTargets,
} from './unit-tests';

const shared: TestTarget = { dir: 'packages/shared', args: ['test'] };
const ui: TestTarget = { dir: 'packages/ui', args: ['test'] };
const panels: TestTarget = { dir: 'packages/panels', args: ['test'] };
const transfer: TestTarget = { dir: 'packages/transfer', args: ['test'] };
const app: TestTarget = { dir: 'packages/app', args: ['test', 'src'] };
const fe: TestTarget = { dir: 'apps/fe', args: ['test', 'src/'] };
const complexity: TestTarget = { dir: '.', args: ['test', 'scripts/complexity'] };
const mesh: TestTarget = { dir: 'apps/gateway', args: ['test', 'src/mesh'], retry: true };
const gwFiles: TestTarget = { dir: 'apps/gateway', args: ['test', 'src/files'], retry: true };
const gwConfig: TestTarget = {
  dir: 'apps/gateway',
  args: ['test', 'src/config.test.ts'],
  retry: true,
};

const targets: TestTarget[] = [
  shared,
  ui,
  panels,
  transfer,
  app,
  fe,
  complexity,
  mesh,
  gwFiles,
  gwConfig,
];

const consumers = new Set(
  (
    [
      { dir: 'packages/panels', dependencies: { '@vibeterm/shared': 'workspace:*' } },
      { dir: 'apps/gateway', dependencies: { '@vibeterm/shared': 'workspace:*' } },
      { dir: 'apps/fe', dependencies: { '@vibeterm/shared': 'workspace:*' } },
      { dir: 'packages/ui', dependencies: {} },
      { dir: 'packages/transfer' },
      { dir: 'packages/app', dependencies: { acme: '^1' } },
    ] as Array<{ dir: string; dependencies?: Record<string, string> }>
  )
    .filter(packageDependsOnShared)
    .map((p) => p.dir)
);

function dirsOf(result: typeof FULL | TestTarget[]): string[] {
  if (result === FULL) return [FULL];
  return result.map((t) => (t.dir === 'apps/gateway' ? `${t.dir}:${t.args[1]}` : t.dir));
}

describe('packageDependsOnShared', () => {
  it('reads dependencies, not a hard-coded package list', () => {
    expect(packageDependsOnShared({ dependencies: { '@vibeterm/shared': 'workspace:*' } })).toBe(
      true
    );
    expect(packageDependsOnShared({ dependencies: { '@vibeterm/ui': 'workspace:*' } })).toBe(false);
    expect(packageDependsOnShared({})).toBe(false);
  });

  it('matches the workspace package.json files', () => {
    const repo = join(import.meta.dir, '..', '..');
    const deps = (dir: string) =>
      JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      };
    expect(packageDependsOnShared(deps('apps/gateway'))).toBe(true);
    expect(packageDependsOnShared(deps('packages/panels'))).toBe(true);
    expect(packageDependsOnShared(deps('packages/ui'))).toBe(false);
    expect(packageDependsOnShared(deps('packages/app'))).toBe(false);
    expect(packageDependsOnShared(deps('packages/transfer'))).toBe(false);
    expect(packageDependsOnShared(deps('packages/ghostty-terminal'))).toBe(false);
    expect(packageDependsOnShared(deps('packages/notifications'))).toBe(false);
  });
});

describe('loadSharedConsumers', () => {
  it('derives consumers from each package.json dependencies', () => {
    const got = loadSharedConsumers();
    expect(got.has('apps/gateway')).toBe(true);
    expect(got.has('apps/fe')).toBe(true);
    expect(got.has('packages/panels')).toBe(true);
    expect(got.has('packages/ui')).toBe(false);
    expect(got.has('packages/app')).toBe(false);
    expect(got.has('packages/transfer')).toBe(false);
    expect(got.has('packages/ghostty-terminal')).toBe(false);
    expect(got.has('packages/notifications')).toBe(false);
    expect(got.has('packages/shared')).toBe(false);
  });
});

describe('TARGETS', () => {
  it('includes packages/transfer in the default matrix', () => {
    expect(TARGETS.some((t) => t.dir === 'packages/transfer' && t.args[0] === 'test')).toBe(true);
  });
});

describe('selectTargets', () => {
  it('returns empty for no changed files', () => {
    expect(selectTargets(targets, [], consumers)).toEqual([]);
  });

  it('selects packages/ui without shared (ui does not depend on @vibeterm/shared)', () => {
    expect(selectTargets(targets, ['packages/ui/src/x.ts'], consumers)).toEqual([ui]);
  });

  it('always includes packages/shared when a consumer is selected', () => {
    expect(selectTargets(targets, ['packages/panels/src/x.ts'], consumers)).toEqual([
      shared,
      panels,
    ]);
  });

  it('returns FULL when packages/shared itself changed', () => {
    expect(selectTargets(targets, ['packages/shared/src/x.ts'], consumers)).toBe(FULL);
  });

  it('returns FULL for root lockfile and config', () => {
    expect(selectTargets(targets, ['bun.lock'], consumers)).toBe(FULL);
    expect(selectTargets(targets, ['package.json'], consumers)).toBe(FULL);
    expect(selectTargets(targets, ['biome.json'], consumers)).toBe(FULL);
    expect(selectTargets(targets, ['tsconfig.json'], consumers)).toBe(FULL);
    expect(selectTargets(targets, ['scripts/ci/unit-tests.ts'], consumers)).toBe(FULL);
    expect(selectTargets(targets, ['scripts/test/preload.ts'], consumers)).toBe(FULL);
  });

  it('does not treat nested package.json as a root config FULL trigger', () => {
    expect(selectTargets(targets, ['packages/ui/package.json'], consumers)).toEqual([ui]);
  });

  it('selects only the touched gateway src split plus shared', () => {
    expect(selectTargets(targets, ['apps/gateway/src/mesh/foo.ts'], consumers)).toEqual([
      shared,
      mesh,
    ]);
  });

  it('selects all gateway splits when package.json, drizzle, or env/test.env change', () => {
    const allGw = [shared, mesh, gwFiles, gwConfig];
    expect(selectTargets(targets, ['apps/gateway/package.json'], consumers)).toEqual(allGw);
    expect(selectTargets(targets, ['apps/gateway/drizzle.config.ts'], consumers)).toEqual(allGw);
    expect(selectTargets(targets, ['apps/gateway/drizzle/0001.sql'], consumers)).toEqual(allGw);
    expect(selectTargets(targets, ['env/test.env'], consumers)).toEqual(allGw);
  });

  it('pairs a top-level gateway source file with its test split', () => {
    expect(selectTargets(targets, ['apps/gateway/src/config.ts'], consumers)).toEqual([
      shared,
      gwConfig,
    ]);
  });

  it('selects packages/transfer when it is touched', () => {
    expect(selectTargets(targets, ['packages/transfer/src/chunker.ts'], consumers)).toEqual([
      transfer,
    ]);
  });

  it('selects the complexity target only for scripts/complexity', () => {
    expect(selectTargets(targets, ['scripts/complexity/gate.ts'], consumers)).toEqual([complexity]);
  });

  it('returns empty when no target is touched', () => {
    expect(selectTargets(targets, ['docs/README.md'], consumers)).toEqual([]);
  });

  it('does not hard-code shared consumers: empty set skips the shared extra', () => {
    expect(dirsOf(selectTargets(targets, ['apps/gateway/src/mesh/foo.ts'], new Set()))).toEqual([
      'apps/gateway:src/mesh',
    ]);
  });
});
