import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FULL,
  ROOT,
  type RunRecord,
  type SelectContext,
  type Selected,
  TARGETS,
  type TestTarget,
  affectedFiles,
  buildWorkspace,
  dependentChains,
  expandParallel,
  failedUnits,
  formatSelection,
  loadWorkspace,
  mergeRecord,
  needsTestqGrant,
  orderByDuration,
  ownerOf,
  parseArgs,
  readRecord,
  relativeImports,
  resolveJobs,
  selectTargets,
  writeRecord,
} from './unit-tests';

const shared: TestTarget = { dir: 'packages/shared', args: ['test'] };
const ui: TestTarget = { dir: 'packages/ui', args: ['test'] };
const stores: TestTarget = { dir: 'packages/stores', args: ['test'] };
const panels: TestTarget = { dir: 'packages/panels', args: ['test'] };
const transfer: TestTarget = { dir: 'packages/transfer', args: ['test'] };
const app: TestTarget = { dir: 'packages/app', args: ['test', 'src'] };
const fe: TestTarget = { dir: 'apps/fe', args: ['test', 'src/'] };
const complexity: TestTarget = { dir: '.', args: ['test', 'scripts/complexity'] };
const ciScripts: TestTarget = { dir: '.', args: ['test', 'scripts/ci'] };
const mesh: TestTarget = { dir: 'apps/gateway', args: ['test', 'src/mesh'], retry: true };
const gwFiles: TestTarget = { dir: 'apps/gateway', args: ['test', 'src/files'], retry: true };
const gwConfig: TestTarget = {
  dir: 'apps/gateway',
  args: ['test', 'src/config.test.ts'],
  retry: true,
};
const allGateway = [mesh, gwFiles, gwConfig];

const targets: TestTarget[] = [
  shared,
  ui,
  stores,
  panels,
  transfer,
  app,
  fe,
  complexity,
  ciScripts,
  mesh,
  gwFiles,
  gwConfig,
];

const dep = (...names: string[]) => Object.fromEntries(names.map((n) => [n, 'workspace:*']));
const workspace = buildWorkspace([
  { dir: 'apps/fe', pkg: { name: '@vibeterm/fe', dependencies: dep('@vibeterm/panels') } },
  {
    dir: 'apps/gateway',
    pkg: { name: '@vibeterm/gateway', dependencies: dep('@vibeterm/shared', '@vibeterm/transfer') },
  },
  { dir: 'packages/app', pkg: { name: 'vibeterm-cli', dependencies: { acme: '^1' } } },
  {
    dir: 'packages/panels',
    pkg: {
      name: '@vibeterm/panels',
      dependencies: dep('@vibeterm/stores', '@vibeterm/shared'),
      devDependencies: dep('@vibeterm/ui'),
    },
  },
  { dir: 'packages/shared', pkg: { name: '@vibeterm/shared' } },
  {
    dir: 'packages/stores',
    pkg: { name: '@vibeterm/stores', peerDependencies: dep('@vibeterm/shared') },
  },
  { dir: 'packages/transfer', pkg: { name: '@vibeterm/transfer' } },
  { dir: 'packages/ui', pkg: { name: '@vibeterm/ui' } },
]);

const identity = (changed: readonly string[]) => new Map(changed.map((f) => [f, f]));
const ctx: SelectContext = { workspace, gatewayAffected: identity };

function pick(files: string[], context: SelectContext = ctx): TestTarget[] | typeof FULL {
  const got = selectTargets(targets, files, context);
  return got === FULL ? FULL : got.map((s) => s.target);
}

describe('workspace graph', () => {
  it('counts dependencies, devDependencies and peerDependencies, ignoring external packages', () => {
    expect(workspace.dependents.get('packages/shared')).toEqual([
      'apps/gateway',
      'packages/panels',
      'packages/stores',
    ]);
    expect(workspace.dependents.get('packages/ui')).toEqual(['packages/panels']);
    expect(workspace.dependents.get('packages/app')).toEqual([]);
  });

  it('follows dependents transitively with the shortest chain', () => {
    const chains = dependentChains(workspace, 'packages/shared');
    expect(chains.get('apps/fe')).toEqual(['packages/shared', 'packages/panels', 'apps/fe']);
    expect(chains.has('packages/shared')).toBe(false);
    expect(chains.has('packages/ui')).toBe(false);
  });

  it('terminates on dependency cycles', () => {
    const cyclic = buildWorkspace([
      { dir: 'a', pkg: { name: 'a', dependencies: dep('b') } },
      { dir: 'b', pkg: { name: 'b', dependencies: dep('a') } },
    ]);
    expect([...dependentChains(cyclic, 'a').keys()]).toEqual(['b']);
  });

  it('maps a file to the package with the longest matching directory', () => {
    const nested = buildWorkspace([
      { dir: 'packages/a', pkg: { name: 'a' } },
      { dir: 'packages/a/inner', pkg: { name: 'inner' } },
    ]);
    expect(ownerOf(nested, 'packages/a/inner/x.ts')).toBe('packages/a/inner');
    expect(ownerOf(nested, 'packages/a/x.ts')).toBe('packages/a');
    expect(ownerOf(nested, 'docs/x.md')).toBeUndefined();
  });

  it('is derived from the real workspace package.json files', () => {
    const real = loadWorkspace(ROOT);
    const shared = dependentChains(real, 'packages/shared');
    expect(shared.has('apps/gateway')).toBe(true);
    expect(shared.has('packages/panels')).toBe(true);
    expect(shared.has('packages/ui')).toBe(false);
    expect(shared.has('packages/app')).toBe(false);
    const stores = dependentChains(real, 'packages/stores');
    expect(stores.has('packages/panels')).toBe(true);
    expect(stores.has('apps/fe')).toBe(true);
  });
});

describe('TARGETS', () => {
  it('includes packages/transfer in the default matrix', () => {
    expect(TARGETS.some((t) => t.dir === 'packages/transfer' && t.args[0] === 'test')).toBe(true);
  });

  it('runs the runner own tests', () => {
    expect(TARGETS.some((t) => t.dir === '.' && t.args[1] === 'scripts/ci')).toBe(true);
  });
});

describe('selectTargets', () => {
  it('returns empty for no changed files', () => {
    expect(selectTargets(targets, [], ctx)).toEqual([]);
  });

  it('selects a leaf package alone', () => {
    expect(pick(['apps/fe/src/x.ts'])).toEqual([fe]);
    expect(pick(['packages/transfer/src/chunker.ts'])).toEqual([transfer, ...allGateway]);
  });

  it('adds the dependents of a changed package', () => {
    expect(pick(['packages/ui/src/x.ts'])).toEqual([ui, panels, fe]);
  });

  it('follows dependents transitively', () => {
    expect(pick(['packages/stores/src/x.ts'])).toEqual([stores, panels, fe]);
  });

  it('selects shared plus its dependents instead of FULL, skipping unrelated packages', () => {
    expect(pick(['packages/shared/src/x.ts'])).toEqual([shared, stores, panels, fe, ...allGateway]);
  });

  it('does not add shared when only a dependent changes', () => {
    expect(pick(['packages/panels/src/x.ts'])).toEqual([panels, fe]);
  });

  it('treats a nested package.json as a change of that package', () => {
    expect(pick(['packages/ui/package.json'])).toEqual([ui, panels, fe]);
  });

  it('returns FULL for root lockfile, root config, preload and the runner itself', () => {
    for (const f of [
      'bun.lock',
      'package.json',
      'biome.json',
      'tsconfig.json',
      'scripts/test/preload.ts',
      'scripts/ci/unit-tests.ts',
      'scripts/ci/unit-select.ts',
      'scripts/ci/unit-run.ts',
    ]) {
      expect(pick([f])).toBe(FULL);
    }
  });

  it('selects only the runner tests when the runner test file changes', () => {
    expect(pick(['scripts/ci/unit-tests.test.ts'])).toEqual([ciScripts]);
    expect(pick(['scripts/ci/sensitive-content.ts'])).toEqual([ciScripts]);
  });

  it('selects only the touched gateway src split', () => {
    expect(pick(['apps/gateway/src/mesh/foo.ts'])).toEqual([mesh]);
  });

  it('adds the gateway splits that import a changed file from another split', () => {
    const crossSplit: SelectContext = {
      workspace,
      gatewayAffected: () =>
        new Map([
          ['apps/gateway/src/mesh/foo.ts', 'apps/gateway/src/mesh/foo.ts'],
          ['apps/gateway/src/files/read.ts', 'apps/gateway/src/mesh/foo.ts'],
        ]),
    };
    const got = selectTargets(targets, ['apps/gateway/src/mesh/foo.ts'], crossSplit);
    expect(got).toEqual([
      { target: mesh, reasons: ['apps/gateway/src/mesh/foo.ts'] },
      {
        target: gwFiles,
        reasons: ['apps/gateway/src/mesh/foo.ts → apps/gateway/src/files/read.ts'],
      },
    ]);
  });

  it('selects all gateway splits when gateway package files, drizzle, or env/test.env change', () => {
    for (const f of [
      'apps/gateway/package.json',
      'apps/gateway/bunfig.toml',
      'apps/gateway/test-preload.ts',
      'apps/gateway/drizzle.config.ts',
      'apps/gateway/drizzle/0001.sql',
      'env/test.env',
    ]) {
      expect(pick([f])).toEqual(allGateway);
    }
  });

  it('pairs a top-level gateway source file with its test split', () => {
    expect(pick(['apps/gateway/src/config.ts'])).toEqual([gwConfig]);
  });

  it('selects gateway splits through a dependency with the dependency chain as reason', () => {
    const got = selectTargets(targets, ['packages/transfer/src/chunker.ts'], ctx);
    expect(got).not.toBe(FULL);
    const gateway = (got as Selected[]).find((s) => s.target === mesh);
    expect(gateway?.reasons).toEqual([
      'packages/transfer/src/chunker.ts → packages/transfer → apps/gateway',
    ]);
  });

  it('selects root script targets by their own scope', () => {
    expect(pick(['scripts/complexity/gate.ts'])).toEqual([complexity]);
  });

  it('returns empty when no target is touched', () => {
    expect(pick(['docs/README.md'])).toEqual([]);
  });

  it('records changed file, package and dependents as reasons', () => {
    const changed = ['packages/stores/src/a.ts', 'packages/stores/src/b.ts'];
    const got = selectTargets(targets, changed, ctx);
    expect(got).toEqual([
      { target: stores, reasons: ['packages/stores/src/a.ts 等 2 个文件 → packages/stores'] },
      {
        target: panels,
        reasons: ['packages/stores/src/a.ts 等 2 个文件 → packages/stores → packages/panels'],
      },
      {
        target: fe,
        reasons: [
          'packages/stores/src/a.ts 等 2 个文件 → packages/stores → packages/panels → apps/fe',
        ],
      },
    ]);
  });
});

describe('gateway import scan', () => {
  it('extracts relative specifiers from every import form', () => {
    const src = [
      "import a from './a';",
      'import type { B } from "../b";',
      "export * from './c';",
      "import './side';",
      "const d = await import('./d');",
      "const e = require('./e');",
      "mock.module('../f', () => ({}));",
      "import ext from 'bun:sqlite';",
      "import s from '@vibeterm/shared';",
    ].join('\n');
    expect(relativeImports(src)).toEqual(['./a', '../b', './c', './side', './d', './e', '../f']);
  });

  const files = (entries: Record<string, string>) => new Map(Object.entries(entries));
  const base = 'apps/gateway/src';

  it('returns importers across directories transitively with their origin', () => {
    const sources = files({
      [`${base}/mesh/core.ts`]: '',
      [`${base}/files/read.ts`]: "import { x } from '../mesh/core';",
      [`${base}/ws/handler.ts`]: "import { r } from '../files/read.js';",
      [`${base}/tmux/other.ts`]: "import { y } from './local';",
      [`${base}/tmux/local.ts`]: '',
    });
    const got = affectedFiles(sources, [`${base}/mesh/core.ts`]);
    expect([...got.keys()].sort()).toEqual([
      `${base}/files/read.ts`,
      `${base}/mesh/core.ts`,
      `${base}/ws/handler.ts`,
    ]);
    expect(got.get(`${base}/ws/handler.ts`)).toBe(`${base}/mesh/core.ts`);
  });

  it('resolves directory index imports, test files and import cycles', () => {
    const sources = files({
      [`${base}/lib/index.ts`]: "export * from './util';",
      [`${base}/lib/util.ts`]: "import './index';",
      [`${base}/api/route.test.ts`]: "import { u } from '../lib';",
    });
    const got = affectedFiles(sources, [`${base}/lib/util.ts`]);
    expect([...got.keys()].sort()).toEqual([
      `${base}/api/route.test.ts`,
      `${base}/lib/index.ts`,
      `${base}/lib/util.ts`,
    ]);
  });

  it('still resolves imports of a deleted file', () => {
    const sources = files({ [`${base}/a/user.ts`]: "import { gone } from '../b/gone';" });
    const got = affectedFiles(sources, [`${base}/b/gone.ts`]);
    expect(got.has(`${base}/a/user.ts`)).toBe(true);
  });
});

describe('parallel expansion', () => {
  it('splits gateway directory groups into one process per test file', () => {
    const units = TARGETS.filter((t) => t.retry).flatMap(expandParallel);
    expect(units.length).toBeGreaterThan(TARGETS.filter((t) => t.retry).length);
    for (const unit of units) {
      expect(unit.retry).toBe(true);
      expect(unit.args).toHaveLength(2);
      expect(unit.args[1]).toMatch(/\.test\.tsx?$/);
    }
  });
});

describe('options', () => {
  it('parses flags and --jobs in both spellings', () => {
    expect(parseArgs([])).toEqual({ changed: false, failed: false, list: false });
    expect(parseArgs(['--changed', '--list', '--jobs', '8'])).toEqual({
      changed: true,
      failed: false,
      list: true,
      jobs: 8,
    });
    expect(parseArgs(['--failed', '--jobs=3']).jobs).toBe(3);
  });

  it('rejects bad input', () => {
    expect(() => parseArgs(['--jobs', '0'])).toThrow();
    expect(() => parseArgs(['--jobs'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow();
    expect(() => parseArgs(['--changed', '--failed'])).toThrow();
  });

  it('uses --jobs, then the testq grant, then serial', () => {
    const opts = parseArgs([]);
    expect(resolveJobs(parseArgs(['--jobs', '4']), { TESTQ_WORKERS: '9' })).toBe(4);
    expect(resolveJobs(opts, { TESTQ_WORKERS: '9' })).toBe(9);
    expect(resolveJobs(opts, {})).toBe(1);
    expect(resolveJobs(opts, { TESTQ_WORKERS: 'x' })).toBe(1);
  });

  it('asks testq for a grant only without --jobs, outside a grant, with testq installed', () => {
    const opts = parseArgs([]);
    expect(needsTestqGrant(opts, {}, true)).toBe(true);
    expect(needsTestqGrant(opts, {}, false)).toBe(false);
    expect(needsTestqGrant(opts, { TESTQ_WORKERS: '6' }, true)).toBe(false);
    expect(needsTestqGrant(parseArgs(['--jobs', '2']), {}, true)).toBe(false);
  });
});

describe('run record', () => {
  const ok = { dir: 'packages/ui', args: ['test'], exitCode: 0, durationMs: 100 };
  const bad = { dir: 'apps/gateway', args: ['test', 'src/mesh/a.test.ts'], retry: true };
  const record = (results: RunRecord['results']): RunRecord => ({ at: 'now', jobs: 2, results });

  it('selects only the failed units for rerun, keeping their retry flag', () => {
    const got = failedUnits(
      record([ok, { ...bad, exitCode: 1, durationMs: 5 }, { ...ok, dir: 'packages/ws-client' }])
    );
    expect(got).toEqual([bad]);
  });

  it('replaces rerun results and keeps the rest when merging', () => {
    const prev = record([ok, { ...bad, exitCode: 1, durationMs: 5 }]);
    const next = record([{ ...bad, exitCode: 0, durationMs: 7 }]);
    const merged = mergeRecord(prev, next);
    expect(merged.results.map((r) => r.exitCode)).toEqual([0, 0]);
    expect(failedUnits(merged)).toEqual([]);
  });

  it('round-trips through the record file and tolerates a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unit-record-'));
    try {
      const path = join(dir, 'nested', 'last.json');
      expect(readRecord(path)).toBeUndefined();
      writeRecord(record([ok]), path);
      expect(readRecord(path)?.results).toEqual([ok]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('schedules the longest previous durations first, unknown units before known', () => {
    const slow = { dir: 'a', args: ['test'] };
    const fast = { dir: 'b', args: ['test'] };
    const fresh = { dir: 'c', args: ['test'] };
    const prev = record([
      { ...fast, exitCode: 0, durationMs: 1 },
      { ...slow, exitCode: 0, durationMs: 9 },
    ]);
    expect(orderByDuration([fast, slow, fresh], prev)).toEqual([fresh, slow, fast]);
  });
});

describe('formatSelection', () => {
  it('prints each target with its reasons and truncates long reason lists', () => {
    const out = formatSelection([
      { target: ui, reasons: ['packages/ui/src/x.ts → packages/ui'] },
      { target: mesh, reasons: ['a', 'b', 'c', 'd', 'e'] },
    ]);
    expect(out).toBe(
      [
        '共 2 个目标：',
        '  packages/ui: bun test',
        '    原因：packages/ui/src/x.ts → packages/ui',
        '  apps/gateway: bun test src/mesh',
        '    原因：a',
        '    原因：b',
        '    原因：c',
        '    … 另有 2 条',
      ].join('\n')
    );
  });
});
