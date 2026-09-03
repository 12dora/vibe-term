import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { format } from 'node:util';

export const DEFAULT_LOG_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_LOG_GENERATIONS = 3;
const MIN_LOG_MAX_BYTES = 4096;
const MIN_LOG_GENERATIONS = 1;

export type RotatingFileWriterOptions = {
  filePath: string;
  maxBytes?: number;
  generations?: number;
  onFdChange?: (fd: number) => void;
};

export class RotatingFileWriter {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly generations: number;
  private fd: number;
  private size: number;
  private pending = '';
  private readonly onFdChange?: (fd: number) => void;

  constructor(options: RotatingFileWriterOptions) {
    this.filePath = options.filePath;
    this.maxBytes = Math.max(MIN_LOG_MAX_BYTES, options.maxBytes ?? DEFAULT_LOG_MAX_BYTES);
    this.generations = Math.max(
      MIN_LOG_GENERATIONS,
      options.generations ?? DEFAULT_LOG_GENERATIONS
    );
    this.onFdChange = options.onFdChange;
    this.fd = openSync(this.filePath, 'a');
    this.size = fstatSync(this.fd).size;
    this.onFdChange?.(this.fd);
  }

  write(chunk: string): void {
    this.pending += chunk;
    let nl = this.pending.indexOf('\n');
    while (nl >= 0) {
      const line = this.pending.slice(0, nl + 1);
      this.pending = this.pending.slice(nl + 1);
      this.writeCompleteLine(line);
      nl = this.pending.indexOf('\n');
    }
  }

  flush(): void {
    if (this.pending.length === 0) return;
    this.writeCompleteLine(this.pending);
    this.pending = '';
  }

  close(): void {
    this.flush();
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
  }

  private writeCompleteLine(line: string): void {
    const buf = Buffer.from(line, 'utf8');
    if (this.size > 0 && this.size + buf.byteLength > this.maxBytes) {
      this.rotate();
    }
    writeSync(this.fd, buf);
    this.size += buf.byteLength;
  }

  private rotate(): void {
    try {
      closeSync(this.fd);
    } catch {
      // already closed
    }
    const backups = this.generations - 1;
    if (backups <= 0) {
      try {
        unlinkSync(this.filePath);
      } catch {
        // missing
      }
    } else {
      try {
        unlinkSync(`${this.filePath}.${backups}`);
      } catch {
        // missing
      }
      for (let i = backups - 1; i >= 1; i--) {
        try {
          renameSync(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`);
        } catch {
          // missing
        }
      }
      try {
        renameSync(this.filePath, `${this.filePath}.1`);
      } catch {
        // missing
      }
    }
    this.fd = openSync(this.filePath, 'a');
    this.size = fstatSync(this.fd).size;
    this.onFdChange?.(this.fd);
  }
}

export type ProcessLogRotationConfig = {
  stdoutPath: string;
  stderrPath: string;
  maxBytes: number;
  generations: number;
};

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

export function shouldInstallProcessLogRotation(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (env.TMEX_LOG_DISABLE === '1') return false;
  if (env.NODE_ENV === 'test' && env.TMEX_LOG_ROTATE !== '1') return false;
  if (env.TMEX_LOG_FILE?.trim()) return true;
  return (
    platform === 'darwin' && env.NODE_ENV === 'production' && Boolean(env.TMEX_INSTALL_DIR?.trim())
  );
}

export function resolveProcessLogRotationConfig(
  env: NodeJS.ProcessEnv = process.env
): ProcessLogRotationConfig | null {
  const explicit = env.TMEX_LOG_FILE?.trim();
  const installDir = env.TMEX_INSTALL_DIR?.trim();
  const stdoutPath = explicit || (installDir ? join(installDir, 'tmex.log') : '');
  if (!stdoutPath) return null;
  const errExplicit = env.TMEX_LOG_ERR_FILE?.trim();
  const stderrPath =
    errExplicit || (installDir ? join(installDir, 'tmex.err.log') : `${stdoutPath}.err`);
  return {
    stdoutPath,
    stderrPath,
    maxBytes: envInt(env, 'TMEX_LOG_MAX_BYTES', DEFAULT_LOG_MAX_BYTES, MIN_LOG_MAX_BYTES),
    generations: envInt(env, 'TMEX_LOG_GENERATIONS', DEFAULT_LOG_GENERATIONS, MIN_LOG_GENERATIONS),
  };
}

type StdWrite = typeof process.stdout.write;

type InstalledRotation = {
  stdout: RotatingFileWriter;
  stderr: RotatingFileWriter;
  restore: () => void;
};

let installed: InstalledRotation | null = null;
let dup2Fn: ((fromFd: number, toFd: number) => void) | null | undefined;

function posixDup2(fromFd: number, toFd: number): void {
  if (dup2Fn === null) return;
  if (dup2Fn === undefined) {
    dup2Fn = loadDup2();
  }
  if (!dup2Fn) return;
  try {
    dup2Fn(fromFd, toFd);
  } catch {
    // JS writes still go through the rotator
  }
}

function loadDup2(): ((fromFd: number, toFd: number) => void) | null {
  try {
    const require = createRequire(import.meta.url);
    const { dlopen, FFIType } = require('bun:ffi') as {
      dlopen: (
        path: string,
        symbols: Record<string, { args: unknown[]; returns: unknown }>
      ) => { symbols: { dup2: (a: number, b: number) => number } };
      FFIType: { i32: unknown };
    };
    const libPath = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
    const lib = dlopen(libPath, {
      dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    return (fromFd, toFd) => {
      lib.symbols.dup2(fromFd, toFd);
    };
  } catch {
    return null;
  }
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8');
  return String(chunk);
}

let captureDepth = 0;

function captureWrite(writer: RotatingFileWriter, text: string): void {
  if (captureDepth > 0) return;
  captureDepth += 1;
  try {
    writer.write(text);
  } finally {
    captureDepth -= 1;
  }
}

function wrapStdStream(stream: NodeJS.WriteStream, writer: RotatingFileWriter): StdWrite {
  const original = stream.write.bind(stream) as StdWrite;
  const wrapped: StdWrite = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    captureWrite(writer, chunkToString(chunk));
    const done =
      typeof encoding === 'function' ? encoding : typeof cb === 'function' ? cb : undefined;
    if (typeof done === 'function') done();
    return true;
  }) as StdWrite;
  stream.write = wrapped;
  return original;
}

function wrapConsoleMethod(
  method: 'log' | 'info' | 'debug' | 'warn' | 'error',
  writer: RotatingFileWriter
): (...args: unknown[]) => void {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    try {
      captureWrite(writer, `${format(...(args as Parameters<typeof format>))}\n`);
    } catch {
      original(...args);
    }
  };
  return original;
}

export function maybeInstallProcessLogRotation(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (installed) return true;
  if (!shouldInstallProcessLogRotation(env, platform)) return false;
  const config = resolveProcessLogRotationConfig(env);
  if (!config) return false;

  const stdout = new RotatingFileWriter({
    filePath: config.stdoutPath,
    maxBytes: config.maxBytes,
    generations: config.generations,
    onFdChange: (fd) => posixDup2(fd, 1),
  });
  const stderrSame = config.stderrPath === config.stdoutPath;
  const stderr = stderrSame
    ? stdout
    : new RotatingFileWriter({
        filePath: config.stderrPath,
        maxBytes: config.maxBytes,
        generations: config.generations,
        onFdChange: (fd) => posixDup2(fd, 2),
      });

  const origStdoutWrite = wrapStdStream(process.stdout, stdout);
  const origStderrWrite = wrapStdStream(process.stderr, stderr);
  const origLog = wrapConsoleMethod('log', stdout);
  const origInfo = wrapConsoleMethod('info', stdout);
  const origDebug = wrapConsoleMethod('debug', stdout);
  const origWarn = wrapConsoleMethod('warn', stderr);
  const origError = wrapConsoleMethod('error', stderr);

  installed = {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      console.log = origLog;
      console.info = origInfo;
      console.debug = origDebug;
      console.warn = origWarn;
      console.error = origError;
      stdout.close();
      if (!stderrSame) stderr.close();
      installed = null;
    },
  };
  return true;
}

export function restoreProcessLogRotationForTest(): void {
  installed?.restore();
}

export function processLogRotationInstalledForTest(): boolean {
  return installed !== null;
}

export function logGenerationPath(filePath: string, generation: number): string {
  return generation <= 0 ? filePath : `${filePath}.${generation}`;
}

export function listLogGenerationPaths(filePath: string, generations: number): string[] {
  const paths = [filePath];
  for (let i = 1; i < generations; i++) {
    const candidate = `${filePath}.${i}`;
    if (existsSync(candidate)) paths.push(candidate);
  }
  return paths;
}
