import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('./prompt.pty-fixture.ts', import.meta.url));
const pythonOk = spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;
const nodeOk = spawnSync('node', ['-e', '0'], { stdio: 'ignore' }).status === 0;

const PASSWORD = 's3cret!';
const PASSWORD_KEYS = 's3cretX\u007f!';
const CODE = '654321';
const TOTP_PROMPT = 'Two-step verification code: ';
const LONG_PROMPT =
  'this setting disables TLS or trusts X-Forwarded-* headers; a LAN client can spoof those headers and bypass address checks? [y/N] ';
const COLUMNS = 80;

function renderPty(raw: string, columns = 0): string {
  const lines: string[] = [''];
  let row = 0;
  let col = 0;
  let wrapPending = false;
  const ensure = (index: number): void => {
    while (lines.length <= index) lines.push('');
  };
  const clampCol = (next: number): number => {
    if (columns > 0) return Math.max(0, Math.min(next, columns - 1));
    return Math.max(0, next);
  };
  const writeAt = (text: string): void => {
    for (const ch of text) {
      if (wrapPending) {
        row += 1;
        col = 0;
        wrapPending = false;
        ensure(row);
      }
      ensure(row);
      const chars = [...(lines[row] ?? '')];
      while (chars.length < col) chars.push(' ');
      chars[col] = ch;
      lines[row] = chars.join('');
      if (columns > 0 && col >= columns - 1) wrapPending = true;
      else col += 1;
    }
  };
  const eraseDown = (): void => {
    ensure(row);
    lines[row] = [...(lines[row] ?? '')].slice(0, col).join('');
    lines.splice(row + 1);
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? '';
    if (ch === '\r') {
      wrapPending = false;
      col = 0;
      continue;
    }
    if (ch === '\n') {
      wrapPending = false;
      row += 1;
      col = 0;
      ensure(row);
      continue;
    }
    if (ch === '\b') {
      wrapPending = false;
      col = Math.max(0, col - 1);
      continue;
    }
    if (ch === '\x1b' && raw[i + 1] === '[') {
      let j = i + 2;
      const parts: string[] = [''];
      while (j < raw.length) {
        const c = raw[j] ?? '';
        if (c >= '0' && c <= '9') {
          parts[parts.length - 1] = `${parts[parts.length - 1]}${c}`;
          j += 1;
          continue;
        }
        if (c === ';') {
          parts.push('');
          j += 1;
          continue;
        }
        if (c >= '@' && c <= '~') {
          const args = parts.map((part) => (part === '' ? 0 : Number(part)));
          wrapPending = false;
          if (c === 'G') col = clampCol((args[0] || 1) - 1);
          else if (c === 'H' || c === 'f') {
            row = Math.max(0, (args[0] || 1) - 1);
            col = clampCol((args[1] || 1) - 1);
            ensure(row);
          } else if (c === 'J' && (args[0] ?? 0) === 0) eraseDown();
          else if (c === 'J' && args[0] === 2) {
            lines.splice(0, lines.length, '');
            row = 0;
            col = 0;
          } else if (c === 'K' && (args[0] ?? 0) === 0) {
            ensure(row);
            lines[row] = [...(lines[row] ?? '')].slice(0, col).join('');
          } else if (c === 'C') col = clampCol(col + (args[0] || 1));
          else if (c === 'D') col = clampCol(col - (args[0] || 1));
          else if (c === 'A') row = Math.max(0, row - (args[0] || 1));
          else if (c === 'B') {
            row += args[0] || 1;
            ensure(row);
          }
          i = j;
          break;
        }
        break;
      }
      continue;
    }
    if (ch >= ' ') writeAt(ch);
  }
  return lines.join('\n');
}

/** 满宽的行是终端折行，拼回去才是逻辑上的一整行。 */
function collapseWrapped(rendered: string, columns: number): string {
  const lines = rendered.split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    out += line;
    if (i < lines.length - 1 && line.length < columns) out += '\n';
  }
  return out;
}

type PtyRun = {
  status: number;
  raw: string;
  timedOut: boolean;
  echo: boolean;
  icanon: boolean;
};

function runPty(
  command: string[],
  mode: 'both' | 'eof' | 'sigint' | 'long',
  resultPath: string
): PtyRun {
  const capturePath = `${resultPath}.pty`;
  const driver = `
import base64, json, os, pty, select, struct, subprocess, sys, termios, time, fcntl
mode = sys.argv[1]
capture_path = sys.argv[2]
cmd = sys.argv[3:]
password = base64.b64decode(os.environ["PTY_PASSWORD_B64"])
code = base64.b64decode(os.environ["PTY_CODE_B64"])
suffix = os.environ.get("PTY_LONG_SUFFIX", "").encode()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
keep = os.dup(slave)
env = os.environ.copy()
env["TERM"] = "xterm-256color"
proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True, close_fds=True)
os.close(slave)
flags = fcntl.fcntl(master, fcntl.F_GETFL)
fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

data = b""

def pump(seconds):
    global data
    end = time.time() + seconds
    while time.time() < end:
        if proc.poll() is not None and time.time() > end - seconds + 0.05:
            break
        timeout = max(0, min(0.05, end - time.time()))
        ready, _, _ = select.select([master], [], [], timeout)
        if not ready:
            continue
        try:
            chunk = os.read(master, 8192)
        except BlockingIOError:
            continue
        if not chunk:
            return
        data += chunk

def wait_for(needle, seconds=2):
    end = time.time() + seconds
    while time.time() < end:
        if needle in data:
            return True
        pump(0.05)
        if proc.poll() is not None:
            return needle in data
    return needle in data

ok = True
if mode == "both":
    ok = wait_for(b"Password: ") and ok
    os.write(master, password + b"\\r")
    ok = wait_for(b"Two-step verification code: ") and ok
    os.write(master, code + b"\\r")
elif mode == "eof":
    ok = wait_for(b"Two-step verification code: ") and ok
    os.write(master, b"\\x04")
elif mode == "sigint":
    ok = wait_for(b"Two-step verification code: ") and ok
    os.write(master, b"\\x03")
elif mode == "long":
    ok = wait_for(suffix) and ok
    os.write(master, b"yex\\x7f\\x7fes\\r")
else:
    sys.stderr.write("unknown mode\\n")
    ok = False

deadline = time.time() + 2
while time.time() < deadline and proc.poll() is None:
    pump(0.05)
timed_out = proc.poll() is None
if timed_out:
    proc.kill()
    proc.wait(timeout=1)
else:
    pump(0.05)
try:
    lflag = termios.tcgetattr(keep)[3]
    echo = bool(lflag & termios.ECHO)
    icanon = bool(lflag & termios.ICANON)
except termios.error:
    echo = False
    icanon = False
os.close(keep)
with open(capture_path, "wb") as handle:
    handle.write(data)
os.close(master)
sys.stdout.write(json.dumps({"echo": echo, "icanon": icanon}) + "\\n")
if timed_out or not ok:
    sys.exit(2)
sys.exit(proc.returncode or 0)
`;
  const dir = mkdtempSync(join(tmpdir(), 'vt-prompt-pty-'));
  const driverPath = join(dir, 'drive.py');
  writeFileSync(driverPath, driver);
  try {
    const run = spawnSync('python3', [driverPath, mode, capturePath, ...command], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PTY_PASSWORD_B64: Buffer.from(PASSWORD_KEYS).toString('base64'),
        PTY_CODE_B64: Buffer.from(CODE).toString('base64'),
        PTY_LONG_SUFFIX: '? [y/N] ',
        PROMPT_RESULT: resultPath,
        PROMPT_TEXT: LONG_PROMPT,
        TERM: 'xterm-256color',
      },
      timeout: 4000,
    });
    const raw = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '';
    let echo = false;
    let icanon = false;
    try {
      const meta = JSON.parse(run.stdout || '') as { echo?: boolean; icanon?: boolean };
      echo = meta.echo === true;
      icanon = meta.icanon === true;
    } catch {
      echo = false;
      icanon = false;
    }
    return {
      status: run.status ?? 1,
      raw,
      timedOut: run.error !== undefined || (run.status ?? 1) === 2,
      echo,
      icanon,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectRestored(run: PtyRun): void {
  expect(run.timedOut, run.raw).toBe(false);
  expect(run.status, run.raw).toBe(0);
  expect(run.echo, run.raw).toBe(true);
  expect(run.icanon, run.raw).toBe(true);
}

describe.skipIf(!pythonOk || !nodeOk)('prompt pty', () => {
  let work = '';
  let bundled = '';

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'vt-prompt-pty-bundle-'));
    bundled = join(work, 'prompt-pty.js');
    const build = spawnSync(
      'bun',
      ['build', fixturePath, '--target', 'node', '--format', 'esm', '--outfile', bundled],
      { encoding: 'utf8' }
    );
    if (build.status !== 0) {
      throw new Error(build.stderr || build.stdout || 'bun build failed');
    }
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const runtimes = ['node', 'bun'] as const;

  function commandFor(runtime: (typeof runtimes)[number]): string[] {
    return runtime === 'node' ? ['node', bundled] : ['bun', fixturePath];
  }

  for (const runtime of runtimes) {
    test(`${runtime}: visible prompt stays and the password is not echoed`, () => {
      const resultPath = join(work, `${runtime}-both.json`);
      const run = runPty([...commandFor(runtime), 'both'], 'both', resultPath);
      const rendered = renderPty(run.raw);
      expectRestored(run);
      const lastClear = run.raw.lastIndexOf('\x1b[0J');
      expect(lastClear, run.raw).toBeGreaterThanOrEqual(0);
      expect(run.raw.slice(lastClear), run.raw).toContain(TOTP_PROMPT);
      expect(rendered, run.raw).toContain('Password: ');
      expect(rendered, run.raw).toContain(`${TOTP_PROMPT}${CODE}`);
      expect(rendered, run.raw).not.toContain(PASSWORD);
      expect(rendered, run.raw).not.toContain('s3cretX');
      expect(run.raw, run.raw).not.toContain(PASSWORD);
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
        password: string;
        code: string;
      };
      expect(result).toEqual({ password: PASSWORD, code: CODE });
    });

    test(`${runtime}: Ctrl+D and Ctrl+C do not hang`, () => {
      const eofPath = join(work, `${runtime}-eof.json`);
      const eof = runPty([...commandFor(runtime), 'eof'], 'eof', eofPath);
      expectRestored(eof);
      expect(renderPty(eof.raw), eof.raw).toContain(TOTP_PROMPT);
      expect(eof.raw.endsWith('\n'), eof.raw).toBe(true);
      expect(eof.raw.endsWith('\n\n'), eof.raw).toBe(false);
      expect(JSON.parse(readFileSync(eofPath, 'utf8'))).toEqual({ value: '' });

      const sigPath = join(work, `${runtime}-sigint.json`);
      const sig = runPty([...commandFor(runtime), 'sigint'], 'sigint', sigPath);
      expectRestored(sig);
      expect(renderPty(sig.raw), sig.raw).toContain(TOTP_PROMPT);
      expect(sig.raw.endsWith('\n'), sig.raw).toBe(true);
      expect(sig.raw.endsWith('\n\n'), sig.raw).toBe(false);
      expect(JSON.parse(readFileSync(sigPath, 'utf8'))).toEqual({ name: 'InterruptError' });
    });

    test(`${runtime}: long prompt is drawn once at 80 columns`, () => {
      expect(LONG_PROMPT.length).toBeGreaterThan(COLUMNS);
      const resultPath = join(work, `${runtime}-long.json`);
      const run = runPty([...commandFor(runtime), 'long'], 'long', resultPath);
      expectRestored(run);
      const collapsed = collapseWrapped(renderPty(run.raw, COLUMNS), COLUMNS).trimEnd();
      expect(collapsed, run.raw).toBe(`${LONG_PROMPT}yes`);
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual({ value: 'yes' });
    });
  }
});
