import { describe, expect, it } from 'bun:test';
import {
  DUP_WINDOW,
  type DupAllowEntry,
  findDuplication,
  formatDupHit,
  isDupAllowed,
  isImportish,
  isStringLiteralOnly,
  tokenizeLine,
} from './duplication';
import { collectIssues, formatReport } from './gate';
import {
  type AllowMap,
  FROZEN_REASON,
  type FnMetrics,
  LIMITS,
  analyzeSource,
  tightenAllowlist,
} from './metrics';

function fn(src: string, name?: string): FnMetrics {
  const { fns } = analyzeSource(src, 'sample.ts');
  const found = name ? fns.find((f) => f.name === name) : fns[0];
  if (!found) throw new Error(`function ${name ?? 0} not found in ${fns.map((f) => f.name)}`);
  return found;
}

function linesOf(n: number, body: string): string {
  return Array.from({ length: n }, () => body).join('\n');
}

describe('LIMITS', () => {
  it('uses the tightened defaults', () => {
    expect(LIMITS).toEqual({ cc: 12, fnLines: 80, fileLines: 500, params: 5, nesting: 4 });
  });
});

describe('cyclomatic complexity', () => {
  it('counts if / && as decisions', () => {
    const m = fn('export function sample(x: number) { if (x) return 1; return x && 2; }');
    expect(m.cc).toBe(3);
  });

  it('flags CC above 12 and accepts 12', () => {
    const ifs = Array.from({ length: 11 }, (_, i) => `if (x === ${i}) return ${i};`).join('\n');
    expect(fn(`export function atLimit(x: number) {\n${ifs}\nreturn 0;\n}`).cc).toBe(12);
    const over = Array.from({ length: 12 }, (_, i) => `if (x === ${i}) return ${i};`).join('\n');
    expect(fn(`export function over(x: number) {\n${over}\nreturn 0;\n}`).cc).toBe(13);
  });
});

describe('function length', () => {
  it('counts start–end lines inclusive', () => {
    const inner = linesOf(78, '  void 0;');
    expect(fn(`export function pad() {\n${inner}\n}\n`).lines).toBe(80);
    const over = linesOf(79, '  void 0;');
    expect(fn(`export function pad() {\n${over}\n}\n`).lines).toBe(81);
  });
});

describe('file length', () => {
  it('warns at 450 and fails above 500', () => {
    const allow: AllowMap = {};
    const fileLines = new Map<string, number>([
      ['a.ts', 450],
      ['b.ts', 500],
      ['c.ts', 501],
    ]);
    const issues = collectIssues({
      fns: [],
      fileLines,
      allow,
      dups: [],
      dupAllow: [],
    });
    expect(issues.warnings.some((w) => w.startsWith('a.ts: 450'))).toBe(true);
    expect(issues.warnings.some((w) => w.startsWith('b.ts: 500'))).toBe(true);
    expect(issues.violations.some((v) => v.startsWith('c.ts: 501'))).toBe(true);
    expect(issues.violations.some((v) => v.startsWith('b.ts:'))).toBe(false);
  });
});

describe('parameter count', () => {
  it('fails at 6 parameters and ignores this', () => {
    expect(fn('export function tooMany(a: 1, b: 2, c: 3, d: 4, e: 5, f: 6) {}').params).toBe(6);
    expect(fn('export function ok(a: 1, b: 2, c: 3, d: 4, e: 5) {}').params).toBe(5);
    expect(
      fn('export function withThis(this: { x: 1 }, a: 1, b: 2, c: 3, d: 4, e: 5) {}').params
    ).toBe(5);
  });
});

describe('nesting depth', () => {
  it('counts if/for/while/switch/try and not plain blocks', () => {
    const deepIf = fn(`export function deepIf() {
      if (1) { if (2) { if (3) { if (4) { if (5) { return; } } } } }
    }`);
    expect(deepIf.nesting).toBe(5);

    const atLimit = fn(`export function atLimit() {
      if (1) { if (2) { if (3) { if (4) { return; } } } }
    }`);
    expect(atLimit.nesting).toBe(4);

    const elseIf = fn(`export function chain(x: number) {
      if (x === 1) return;
      else if (x === 2) return;
      else if (x === 3) return;
      else if (x === 4) return;
      else if (x === 5) return;
    }`);
    expect(elseIf.nesting).toBe(1);

    const blocks = fn(`export function blocks() {
      { { { { { return; } } } } }
    }`);
    expect(blocks.nesting).toBe(0);

    const mixed = fn(`export function mixed() {
      for (const x of []) {
        while (x) {
          switch (x) {
            default:
              try { if (x) return; } catch { return; }
          }
        }
      }
    }`);
    expect(mixed.nesting).toBe(5);
  });

  it('counts anonymous arrow-callback block bodies', () => {
    const arrows = fn(`export function arrows(items: number[]) {
      items.map(() => {
        items.map(() => {
          items.map(() => {
            items.map(() => {
              items.map(() => { return 1; });
            });
          });
        });
      });
    }`);
    expect(arrows.nesting).toBe(5);
  });
});

describe('duplication detector', () => {
  const cloneBody = Array.from(
    { length: DUP_WINDOW + 2 },
    (_, i) => `  const slot${i} = computeValue(input, ${i});`
  ).join('\n');

  it('flags a token-hash window across two files', () => {
    const text = `export function run(input: number) {\n${cloneBody}\n  return input;\n}\n`;
    const hits = findDuplication([
      { rel: 'a.ts', text },
      { rel: 'b.ts', text },
    ]);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.fileA).toBe('a.ts');
    expect(hits[0]?.fileB).toBe('b.ts');
    expect(hits[0]?.lines ?? 0).toBeGreaterThanOrEqual(DUP_WINDOW);
    expect(formatDupHit(hits[0]!)).toMatch(/^a\.ts:\d+ ↔ b\.ts:\d+ \(\d+ lines\)$/);
  });

  it('does not flag renamed identifiers as the same window', () => {
    const a = `export function alpha(input: number) {\n${cloneBody}\n  return input;\n}\n`;
    const b = `export function beta(input: number) {\n${cloneBody.replace(/slot/g, 'cell')}\n  return input;\n}\n`;
    expect(
      findDuplication([
        { rel: 'a.ts', text: a },
        { rel: 'b.ts', text: b },
      ])
    ).toEqual([]);
  });

  it('ignores import blocks', () => {
    const imports = Array.from(
      { length: 16 },
      (_, i) => `import { foo${i} } from './mod${i}';`
    ).join('\n');
    const hits = findDuplication([
      { rel: 'a.ts', text: `${imports}\nexport const a = 1;\n` },
      { rel: 'b.ts', text: `${imports}\nexport const b = 2;\n` },
    ]);
    expect(hits).toEqual([]);
  });

  it('ignores string-literal-only windows', () => {
    const union = [
      'export type Kind =',
      ...Array.from({ length: 16 }, (_, i) => `  | 'k${i}'`),
    ].join('\n');
    const hits = findDuplication([
      { rel: 'a.ts', text: `${union};\n` },
      { rel: 'b.ts', text: `${union};\n` },
    ]);
    expect(hits).toEqual([]);
  });

  it('ignores palette / usage-string / export-list noise', () => {
    const palette = [
      'export const colors = {',
      ...Array.from({ length: 16 }, (_, i) => `  c${i}: '#${i.toString().padStart(6, '0')}',`),
      '};',
    ].join('\n');
    const usage = [
      'export const command = {',
      '  usage: [',
      ...Array.from({ length: 16 }, (_, i) => `    'line ${i}',`),
      '  ],',
      '};',
    ].join('\n');
    expect(
      findDuplication([
        { rel: 'a.ts', text: `${palette}\n` },
        { rel: 'b.ts', text: `${palette}\n` },
      ])
    ).toEqual([]);
    expect(
      findDuplication([
        { rel: 'a.ts', text: `${usage}\n` },
        { rel: 'b.ts', text: `${usage}\n` },
      ])
    ).toEqual([]);
    const iface = [
      'export interface Theme {',
      ...Array.from({ length: 16 }, (_, i) => `  c${i}: string;`),
      '}',
    ].join('\n');
    expect(
      findDuplication([
        { rel: 'a.ts', text: `${iface}\n` },
        { rel: 'b.ts', text: `${iface}\n` },
      ])
    ).toEqual([]);
  });

  it('respects the duplication allowlist', () => {
    const text = `export function run(input: number) {\n${cloneBody}\n  return input;\n}\n`;
    const hits = findDuplication([
      { rel: 'left.ts', text },
      { rel: 'right.ts', text },
    ]);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const allow: DupAllowEntry[] = [{ a: 'right.ts', b: 'left.ts', reason: 'intentional' }];
    expect(isDupAllowed(hits[0]!, allow)).toBe(true);
    const issues = collectIssues({
      fns: [],
      fileLines: new Map(),
      allow: {},
      dups: hits,
      dupAllow: allow,
    });
    expect(issues.violations).toEqual([]);
  });

  it('classifies import-ish and string-only token lines', () => {
    expect(isImportish(tokenizeLine("import { x } from './y';"))).toBe(true);
    expect(isImportish(tokenizeLine('export function run() {}'))).toBe(false);
    expect(isStringLiteralOnly([tokenizeLine("  | 'alpha'"), tokenizeLine("  | 'beta'")])).toBe(
      true
    );
  });
});

describe('allowlist tighten + evaluate', () => {
  it('freezes current over-limit values and drops stale / shrunk entries', () => {
    const src = `
export function keepHot(x: number) {
  ${Array.from({ length: 13 }, (_, i) => `if (x === ${i}) return ${i};`).join('\n  ')}
  return 0;
}
export function shrunk(x: number) { return x ? 1 : 0; }
`;
    const { fns, lines } = analyzeSource(src, 'hot.ts');
    const keep = fns.find((f) => f.name === 'keepHot');
    expect(keep?.cc ?? 0).toBeGreaterThan(LIMITS.cc);

    const old: AllowMap = {
      'hot.ts:keepHot': { cc: 99, reason: 'old' },
      'hot.ts:shrunk': { cc: 20, lines: 200, reason: 'gone hot' },
      'hot.ts:movedAway': { cc: 18, reason: 'stale fn' },
      'hot.ts': { fileLines: 900, reason: 'old file' },
      'missing.ts': { fileLines: 700, reason: 'missing file' },
    };
    const fileLines = new Map([['hot.ts', lines]]);
    const next = tightenAllowlist(old, fns, fileLines);
    expect(next['hot.ts:movedAway']).toBeUndefined();
    expect(next['missing.ts']).toBeUndefined();
    expect(next['hot.ts:shrunk']).toBeUndefined();
    expect(next['hot.ts']).toBeUndefined();
    expect(next['hot.ts:keepHot']?.cc).toBe(keep?.cc);
    expect(next['hot.ts:keepHot']?.cc ?? 99).toBeLessThan(99);
    expect(next['hot.ts:keepHot']?.reason).toBe('old');
  });

  it('adds frozen entries for pre-existing violations not yet allowlisted', () => {
    const src = 'export function tooMany(a: 1, b: 2, c: 3, d: 4, e: 5, f: 6) { return a; }\n';
    const { fns, lines } = analyzeSource(src, 'p.ts');
    const next = tightenAllowlist({}, fns, new Map([['p.ts', lines]]));
    expect(next['p.ts:tooMany']?.params).toBe(6);
    expect(next['p.ts:tooMany']?.reason).toBe(FROZEN_REASON);
  });

  it('allowlisted entries may only shrink: exceeding the recorded cap still fails', () => {
    const m = fn('export function tooMany(a: 1, b: 2, c: 3, d: 4, e: 5, f: 6) { return a; }');
    const issues = collectIssues({
      fns: [m],
      fileLines: new Map([['sample.ts', 3]]),
      allow: { 'sample.ts:tooMany': { params: 5, reason: 'capped' } },
      dups: [],
      dupAllow: [],
    });
    expect(issues.violations.some((v) => v.includes('6 params > 5'))).toBe(true);
  });

  it('reports stale allowlist keys', () => {
    const issues = collectIssues({
      fns: [],
      fileLines: new Map(),
      allow: { 'gone.ts:fn': { cc: 20, reason: 'x' } },
      dups: [],
      dupAllow: [],
    });
    expect(issues.stale).toEqual(['gone.ts:fn']);
  });
});

describe('--report', () => {
  it('prints per-metric counts and top offenders', () => {
    const m = fn('export function tooMany(a: 1, b: 2, c: 3, d: 4, e: 5, f: 6) { return a; }');
    const text = formatReport({
      files: 1,
      fns: [m],
      fileLines: new Map([['sample.ts', 3]]),
      dups: [{ fileA: 'a.ts', lineA: 1, fileB: 'b.ts', lineB: 2, lines: 16 }],
    });
    expect(text).toContain('CC>12:');
    expect(text).toContain('fn>80:');
    expect(text).toContain('file>500:');
    expect(text).toContain('params>5:');
    expect(text).toContain('nesting>4:');
    expect(text).toContain('duplication:');
    expect(text).toContain('top CC:');
    expect(text).toContain('top duplication:');
    expect(text).toContain('a.ts:1 ↔ b.ts:2 (16 lines)');
  });
});
