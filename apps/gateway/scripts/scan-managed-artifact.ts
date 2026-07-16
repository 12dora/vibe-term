/**
 * Managed Gateway artifact fail-closed scanner。
 *
 * 拒绝：Bun sidecar、源码、node_modules、tmex CLI、fe-dist、自更新 route/npm/CDN 特征。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const FORBIDDEN_NAME_PATTERNS = [
  /^bun(\.exe)?$/i,
  /^node(\.exe)?$/i,
  /node_modules/i,
  /fe-dist/i,
  /^tmex(\.js)?$/i,
  /^tmex-cli/i,
  /\.ts$/i,
  /\.tsx$/i,
  /\.jsx$/i,
  /\.mjs$/i,
  /package\.json$/i,
  /package-lock\.json$/i,
  /bun\.lockb?$/i,
];

const FORBIDDEN_CONTENT_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'npm-registry', re: /registry\.npmjs\.org\/tmex-cli/i },
  { id: 'jsdelivr-cdn', re: /cdn\.jsdelivr\.net\/npm\/tmex-cli/i },
  // managed 可保留 route 字面量以返回 managed_externally；禁止真实自更新实现特征
  { id: 'bun-add-upgrade', re: /bun\s+add\s+tmex-cli@/i },
  { id: 'apply-current-package', re: /--apply-current-package/ },
  { id: 'npm-packument-fetch', re: /dist-tags[\s\S]{0,40}latest/i },
];

export interface ScanResult {
  ok: boolean;
  path: string;
  sizeBytes: number;
  sha256: string;
  findings: string[];
  adjacentFindings: string[];
}

function listAdjacent(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function scanManagedArtifact(artifactPath: string): ScanResult {
  const abs = resolve(artifactPath);
  const findings: string[] = [];
  const adjacentFindings: string[] = [];

  if (!existsSync(abs)) {
    return {
      ok: false,
      path: abs,
      sizeBytes: 0,
      sha256: '',
      findings: ['artifact_missing'],
      adjacentFindings: [],
    };
  }

  const st = statSync(abs);
  if (!st.isFile()) {
    findings.push('not_a_file');
  }
  if (st.size < 1024 * 100) {
    findings.push('suspiciously_small');
  }

  const buf = readFileSync(abs);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const textSample = buf.toString('utf8');

  for (const { id, re } of FORBIDDEN_CONTENT_PATTERNS) {
    if (re.test(textSample)) {
      findings.push(`content:${id}`);
    }
  }

  // 二进制旁不得放 sidecar / 源码布局
  const dir = dirname(abs);
  for (const name of listAdjacent(dir)) {
    for (const re of FORBIDDEN_NAME_PATTERNS) {
      if (re.test(name)) {
        adjacentFindings.push(`adjacent:${name}`);
      }
    }
  }

  // artifact 自身不得叫 bun / tmex cli
  const base = basename(abs);
  if (/^bun/i.test(base) || /^tmex\.js$/i.test(base)) {
    findings.push(`bad_artifact_name:${base}`);
  }

  // 不得是指向 node_modules 的链接
  try {
    const real = realpathSync(abs);
    if (real.includes(`${join('', 'node_modules')}`) || real.includes('/node_modules/')) {
      findings.push('realpath_in_node_modules');
    }
  } catch {
    // ignore
  }

  const ok = findings.length === 0 && adjacentFindings.length === 0;
  return {
    ok,
    path: abs,
    sizeBytes: st.size,
    sha256,
    findings,
    adjacentFindings,
  };
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: bun scripts/scan-managed-artifact.ts <artifact>');
    process.exit(2);
  }
  const result = scanManagedArtifact(path);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.main) {
  main();
}
