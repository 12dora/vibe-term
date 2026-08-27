import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRequestedFile, serveFrontend } from './serve-frontend';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStaticRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tmex-fe-'));
  tempDirs.push(root);
  await writeFile(join(root, 'index.html'), '<html>ok</html>');
  return root;
}

describe('resolveRequestedFile', () => {
  test('returns null for malformed percent-encoding', async () => {
    const root = await makeStaticRoot();
    expect(resolveRequestedFile(root, '/%ZZ')).toBeNull();
    expect(resolveRequestedFile(root, '/%E0%A4%A')).toBeNull();
    expect(resolveRequestedFile(root, '/%')).toBeNull();
  });

  test('returns null for path traversal', async () => {
    const root = await makeStaticRoot();
    expect(resolveRequestedFile(root, '../../../../etc/passwd')).toBeNull();
  });
});

describe('serveFrontend', () => {
  test('answers 400 for malformed percent-encoding', async () => {
    const root = await makeStaticRoot();
    const response = await serveFrontend(new Request('http://127.0.0.1/%ZZ'), root);
    expect(response.status).toBe(400);
  });
});
