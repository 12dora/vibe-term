import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanManagedArtifact } from './scan-managed-artifact';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(name: string, content = ''): string {
  const root = join(tmpdir(), `tmex-managed-scan-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const artifact = join(root, name);
  writeFileSync(artifact, Buffer.concat([Buffer.alloc(128 * 1024), Buffer.from(content)]));
  return artifact;
}

describe('managed artifact fail-closed scanner', () => {
  test('拒绝真实自更新实现特征', () => {
    const artifact = fixture('gateway', 'registry.npmjs.org/tmex-cli');
    const result = scanManagedArtifact(artifact);
    expect(result.ok).toBe(false);
    expect(result.findings).toContain('content:npm-registry');
  });

  test('拒绝二进制旁的 node_modules sidecar', () => {
    const artifact = fixture('gateway');
    mkdirSync(join(artifact, '..', 'node_modules'));
    const result = scanManagedArtifact(artifact);
    expect(result.ok).toBe(false);
    expect(result.adjacentFindings).toContain('adjacent:node_modules');
  });

  test('允许无 sidecar 且不含禁用特征的独立大文件', () => {
    const artifact = fixture('gateway');
    expect(scanManagedArtifact(artifact).ok).toBe(true);
  });

  test('manifest 目录下缺 ghostty wasm 或 sha 不符均拒绝', () => {
    const artifact = fixture('tmex-gateway-managed-darwin-arm64');
    const dir = join(artifact, '..');
    writeFileSync(
      join(dir, 'target-matrix.json'),
      JSON.stringify({
        schemaVersion: 1,
        adjacentResources: [{ name: 'ghostty-vt.wasm', sha256: 'abc' }],
        targets: [],
      })
    );
    const missing = scanManagedArtifact(artifact);
    expect(missing.ok).toBe(false);
    expect(missing.findings).toContain('adjacent_resource_missing:ghostty-vt.wasm');

    writeFileSync(join(dir, 'ghostty-vt.wasm'), 'not-the-real-wasm');
    const mismatch = scanManagedArtifact(artifact);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.findings).toContain('adjacent_resource_sha_mismatch:ghostty-vt.wasm');

    const { createHash } = require('node:crypto');
    const wasmSha = createHash('sha256').update(Buffer.from('not-the-real-wasm')).digest('hex');
    writeFileSync(
      join(dir, 'target-matrix.json'),
      JSON.stringify({
        schemaVersion: 1,
        adjacentResources: [{ name: 'ghostty-vt.wasm', sha256: wasmSha }],
        targets: [],
      })
    );
    expect(scanManagedArtifact(artifact).ok).toBe(true);
  });
});
