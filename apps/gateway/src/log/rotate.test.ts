import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOG_GENERATIONS,
  DEFAULT_LOG_MAX_BYTES,
  RotatingFileWriter,
  listLogGenerationPaths,
  maybeInstallProcessLogRotation,
  processLogRotationInstalledForTest,
  processLogStdoutDupTargets,
  resolveProcessLogRotationConfig,
  restoreProcessLogRotationForTest,
  shouldInstallProcessLogRotation,
} from './rotate';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-log-rotate-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  restoreProcessLogRotationForTest();
  delete process.env.TMEX_LOG_FILE;
  delete process.env.TMEX_LOG_ERR_FILE;
  delete process.env.TMEX_LOG_ROTATE;
  delete process.env.TMEX_LOG_DISABLE;
  delete process.env.TMEX_LOG_MAX_BYTES;
  delete process.env.TMEX_LOG_GENERATIONS;
  delete process.env.TMEX_INSTALL_DIR;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function readGenerations(filePath: string, generations: number): Promise<string> {
  const chunks: string[] = [];
  for (const path of listLogGenerationPaths(filePath, generations).reverse()) {
    chunks.push(await readFile(path, 'utf8'));
  }
  return chunks.join('');
}

describe('RotatingFileWriter', () => {
  test('writes past the cap roll over, keeps generations, and does not lose or split lines', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'tmex.log');
    const maxBytes = 4096;
    const generations = 3;
    const writer = new RotatingFileWriter({ filePath, maxBytes, generations });
    const total = 400;
    try {
      for (let i = 1; i <= total; i++) {
        writer.write(`line-${String(i).padStart(4, '0')}-${'x'.repeat(40)}\n`);
      }
    } finally {
      writer.close();
    }

    const paths = listLogGenerationPaths(filePath, generations);
    expect(paths[0]).toBe(filePath);
    expect(paths.length).toBeGreaterThan(1);
    expect(paths.length).toBeLessThanOrEqual(generations);

    const { statSync } = await import('node:fs');
    for (const path of paths) {
      expect(statSync(path).size).toBeLessThanOrEqual(maxBytes + 80);
    }

    const combined = await readGenerations(filePath, generations);
    const lines = combined.split('\n').filter(Boolean);
    expect(lines.every((line) => /^line-\d{4}-x+$/.test(line))).toBe(true);
    const ids = lines.map((line) => Number(line.slice(5, 9)));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBeGreaterThanOrEqual(1);
    expect(ids[ids.length - 1]).toBe(total);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => ids[0]! + i));
  });

  test('drops the oldest generation once the cap is exceeded', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'app.log');
    const writer = new RotatingFileWriter({ filePath, maxBytes: 4096, generations: 3 });
    try {
      for (let i = 0; i < 800; i++) {
        writer.write(`g-${String(i).padStart(5, '0')}-${'y'.repeat(50)}\n`);
      }
    } finally {
      writer.close();
    }
    const { existsSync } = await import('node:fs');
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.1`)).toBe(true);
    expect(existsSync(`${filePath}.2`)).toBe(true);
    expect(existsSync(`${filePath}.3`)).toBe(false);
  });

  test('does not split a line across files even when the line exceeds maxBytes', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'wide.log');
    const writer = new RotatingFileWriter({ filePath, maxBytes: 4096, generations: 2 });
    const huge = `huge-${'z'.repeat(5000)}\n`;
    const next = 'after-huge\n';
    try {
      writer.write(huge);
      writer.write(next);
    } finally {
      writer.close();
    }
    const current = await readFile(filePath, 'utf8');
    expect(current).toBe(next);
    const previous = await readFile(`${filePath}.1`, 'utf8');
    expect(previous).toBe(huge);
    expect(previous.endsWith('\n')).toBe(true);
    expect(previous.includes('\n', 0) && previous.indexOf('\n') === previous.length - 1).toBe(true);
  });

  test('onFdChange fires on construct and each rotate with the new fd', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'fd.log');
    const fds: number[] = [];
    const writer = new RotatingFileWriter({
      filePath,
      maxBytes: 4096,
      generations: 2,
      onFdChange: (fd) => fds.push(fd),
    });
    try {
      expect(fds.length).toBe(1);
      for (let i = 0; i < 200; i++) {
        writer.write(`line-${String(i).padStart(3, '0')}-${'x'.repeat(40)}\n`);
      }
    } finally {
      writer.close();
    }
    expect(fds.length).toBeGreaterThan(1);
    expect(fds.every((fd) => Number.isInteger(fd) && fd >= 0)).toBe(true);
  });
});

describe('process log rotation config', () => {
  test('honours env overrides and defaults', () => {
    expect(DEFAULT_LOG_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(DEFAULT_LOG_GENERATIONS).toBe(3);
    process.env.TMEX_LOG_FILE = '/tmp/custom.log';
    process.env.TMEX_LOG_ERR_FILE = '/tmp/custom.err';
    process.env.TMEX_LOG_MAX_BYTES = '8192';
    process.env.TMEX_LOG_GENERATIONS = '2';
    expect(resolveProcessLogRotationConfig()).toEqual({
      stdoutPath: '/tmp/custom.log',
      stderrPath: '/tmp/custom.err',
      maxBytes: 8192,
      generations: 2,
    });
  });

  test('installs on darwin production via TMEX_INSTALL_DIR, skips Linux and tests', () => {
    expect(
      shouldInstallProcessLogRotation(
        { NODE_ENV: 'production', TMEX_INSTALL_DIR: '/tmp/tmex' },
        'darwin'
      )
    ).toBe(true);
    expect(
      shouldInstallProcessLogRotation(
        { NODE_ENV: 'production', TMEX_INSTALL_DIR: '/tmp/tmex' },
        'linux'
      )
    ).toBe(false);
    expect(
      shouldInstallProcessLogRotation(
        { NODE_ENV: 'test', TMEX_LOG_FILE: '/tmp/tmex.log' },
        'darwin'
      )
    ).toBe(false);
    expect(
      shouldInstallProcessLogRotation(
        { NODE_ENV: 'test', TMEX_LOG_FILE: '/tmp/tmex.log', TMEX_LOG_ROTATE: '1' },
        'darwin'
      )
    ).toBe(true);
    expect(
      shouldInstallProcessLogRotation(
        { NODE_ENV: 'production', TMEX_INSTALL_DIR: '/tmp/tmex', TMEX_LOG_DISABLE: '1' },
        'darwin'
      )
    ).toBe(false);
  });

  test('maybeInstall is a no-op during bun test unless TMEX_LOG_ROTATE=1', () => {
    expect(maybeInstallProcessLogRotation()).toBe(false);
    expect(processLogRotationInstalledForTest()).toBe(false);
  });

  test('shared stdout/stderr path dup2s both fd 1 and fd 2 on rotate', () => {
    expect(processLogStdoutDupTargets(false)).toEqual([1]);
    expect(processLogStdoutDupTargets(true)).toEqual([1, 2]);
  });
});
