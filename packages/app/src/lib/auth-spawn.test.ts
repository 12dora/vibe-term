import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { type AuthSpawnPlan, spawnAuthCli } from './auth-spawn';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function captureStream(): { stream: Writable; text: () => string; chunks: Buffer[] } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  return {
    stream,
    chunks,
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for child output');
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('spawnAuthCli', () => {
  test('live-forwards fake child stdout/stderr on a non-TTY destination and propagates exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tmex-auth-spawn-'));
    tempDirs.push(dir);
    const readyPath = join(dir, 'ready');
    const goPath = join(dir, 'go');
    const childPath = join(dir, 'fake-child.mjs');
    await writeFile(
      childPath,
      `import { existsSync, writeFileSync } from 'node:fs';
process.stdout.write('JOIN_TOKEN abc\\n');
writeFileSync(process.argv[2], 'ready');
const go = process.argv[3];
const timer = setInterval(() => {
  if (existsSync(go)) {
    clearInterval(timer);
    process.stdout.write('node admitted\\n');
    process.stderr.write('warn-line\\n');
    process.exit(4);
  }
}, 15);
setTimeout(() => process.exit(99), 8000);
`
    );
    await chmod(childPath, 0o755);

    const stdout = captureStream();
    const stderr = captureStream();
    const plan: AuthSpawnPlan = {
      bunBin: process.execPath,
      cliAuthPath: childPath,
      argv: [readyPath, goPath],
      env: { ...process.env },
    };

    const resultPromise = spawnAuthCli(plan, {
      stdin: 'ignore',
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    await waitUntil(() => stdout.text().includes('JOIN_TOKEN abc'));
    expect(stdout.text()).toBe('JOIN_TOKEN abc\n');
    expect(stderr.text()).toBe('');

    await writeFile(goPath, 'go');
    const result = await resultPromise;

    expect(result.code).toBe(4);
    expect(result.stdout).toBe('JOIN_TOKEN abc\nnode admitted\n');
    expect(result.stderr).toBe('warn-line\n');
    expect(stdout.text()).toBe('JOIN_TOKEN abc\nnode admitted\n');
    expect(stderr.text()).toBe('warn-line\n');
  });
});
