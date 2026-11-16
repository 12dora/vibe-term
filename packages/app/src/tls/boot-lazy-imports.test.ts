import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';

const REPO_ROOT = join(import.meta.dir, '../../../..');
const SCAN_ROOTS = ['apps/gateway/src', 'packages/app/src', 'packages/shared/src'];
const HEAVY = [
  '@simplewebauthn/server',
  '@peculiar/[^\'"]+',
  'asn1js',
  'tsyringe',
  'reflect-metadata',
  'pvtsutils',
  '@levischuck/tiny-cbor',
  'hash-wasm',
];
// CLI 子命令入口不在常驻进程启动链上
const ALLOWED = new Set(['packages/app/src/cli-auth-entry.ts']);
const STATIC_IMPORT = new RegExp(
  `^\\s*(?:import|export)\\s+(?!type\\b)(?:[^'";]*?\\sfrom\\s+)?['"](?:${HEAVY.join('|')})(?:/[^'"]*)?['"]`,
  'm'
);

function sourceFiles(): string[] {
  const glob = new Glob('**/*.{ts,tsx}');
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of glob.scanSync({ cwd: join(REPO_ROOT, root) })) {
      if (/\.test\.tsx?$|test-fixtures\.ts$|\.d\.ts$/.test(file)) continue;
      out.push(join(REPO_ROOT, root, file));
    }
  }
  return out;
}

describe('boot import graph', () => {
  test('pattern matches static imports but not type-only or dynamic ones', () => {
    expect(STATIC_IMPORT.test("import 'reflect-metadata';")).toBe(true);
    expect(STATIC_IMPORT.test("import { argon2id } from 'hash-wasm';")).toBe(true);
    expect(STATIC_IMPORT.test("import {\n  a,\n} from '@simplewebauthn/server';")).toBe(true);
    expect(STATIC_IMPORT.test("import * as X from '@peculiar/x509';")).toBe(true);
    expect(STATIC_IMPORT.test("import type * as X from '@peculiar/x509';")).toBe(false);
    expect(STATIC_IMPORT.test("await import('@peculiar/x509');")).toBe(false);
  });

  test('WebAuthn / X.509 / ASN.1 / Argon2 stacks are only loaded via dynamic import', () => {
    const offenders = sourceFiles()
      .map((file) => relative(REPO_ROOT, file))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => STATIC_IMPORT.test(readFileSync(join(REPO_ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
