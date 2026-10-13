import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Device } from '@vibeterm/shared';
import type { SshExecResult } from './directory-browse';
import {
  type MoveStatus,
  buildMoveCommand,
  buildMoveScript,
  fileMoveRemoteIo,
  moveRemote,
  outcomesFromStatuses,
  parseMoveOutput,
  splitMoveBatch,
} from './move-remote';
import type { MoveBatch, MoveItem } from './move-types';
import type { RsyncDeviceSpec } from './ssh-command';

const enc = (s: string) => new TextEncoder().encode(s);

function item(parent: string, name: string, destName = name): MoveItem {
  return { path: `${parent}/${name}`, parent, name, destName };
}

function makeBatch(items: MoveItem[], over: Partial<MoveBatch> = {}): MoveBatch {
  return {
    rootPath: '/srv/root',
    destRootPath: '/srv/root',
    destDir: '/srv/root/dest',
    overwrite: false,
    items,
    ...over,
  };
}

describe('buildMoveScript', () => {
  test('quotes every argument and always passes -- to cd and mv', () => {
    const script = buildMoveScript(
      makeBatch([item("/srv/root/it's here", '-dash name', "o'ther")], {
        destDir: '/srv/root/de st',
      })
    );
    expect(script).toContain("cd -- '/srv/root' || exit 60");
    expect(script).toContain("cd -- '/srv/root/de st' || exit 63");
    expect(script).toContain(`vt 0 '/srv/root/it'\\''s here' '-dash name' 'o'\\''ther'`);
    expect(script).toContain('mv -f -- "$s" "$dp"');
    expect(script).toContain('s="./$n"');
    expect(script).toContain('ow=0');
  });

  test('overwrite flag is encoded and indices follow batch order', () => {
    const script = buildMoveScript(
      makeBatch([item('/srv/root', 'a'), item('/srv/root', 'b')], { overwrite: true })
    );
    expect(script).toContain('ow=1');
    expect(script.indexOf("vt 0 '/srv/root' 'a' 'a'")).toBeLessThan(
      script.indexOf("vt 1 '/srv/root' 'b' 'b'")
    );
  });

  test('buildMoveCommand wraps the script in sh -c', () => {
    const cmd = buildMoveCommand(makeBatch([item('/srv/root', 'a')]));
    expect(cmd.startsWith("sh -c '")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
  });
});

describe('parseMoveOutput', () => {
  test('parses status lines and tolerates CRLF and noise', () => {
    const parsed = parseMoveOutput(
      enc(
        'noise\nVTOP 0 ok\r\nVTOP 1 already_exists\nVTOP 2 weird_word\nVTOP x ok\nVTOP 3 invalid\n'
      )
    );
    expect(parsed.get(0)).toBe('ok');
    expect(parsed.get(1)).toBe('already_exists');
    expect(parsed.get(2)).toBe('unknown');
    expect(parsed.get(3)).toBe('invalid');
    expect(parsed.size).toBe(4);
  });

  test('items without a status line become unknown', () => {
    const statuses = new Map<number, MoveStatus>([[0, 'ok']]);
    const outcomes = outcomesFromStatuses(statuses, 2);
    expect(outcomes[0]).toEqual({ ok: true, data: undefined });
    expect(outcomes[1]).toEqual({ ok: false, code: 'unknown', detail: undefined });
  });
});

describe('splitMoveBatch', () => {
  test('keeps a normal request in one chunk and splits when over budget', () => {
    const items = Array.from({ length: 6 }, (_, i) => item('/srv/root', `file-${i}`));
    expect(splitMoveBatch(makeBatch(items))).toHaveLength(1);
    const chunks = splitMoveBatch(makeBatch(items), 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.items)).toEqual(items);
  });

  test('empty batch yields one empty chunk', () => {
    expect(splitMoveBatch(makeBatch([]))).toHaveLength(1);
  });
});

const fakeSpec: RsyncDeviceSpec = {
  targetPrefix: 'user@host:',
  rsh: 'ssh -o BatchMode=yes',
  env: {},
  cleanup: () => {},
};

const device: Device = {
  id: 'move-remote-test-device',
  name: 'move-remote',
  type: 'ssh',
  host: '127.0.0.1',
  username: 'nobody',
  authMode: 'agent',
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const originalExec = fileMoveRemoteIo.exec;
const originalHooks = fileMoveRemoteIo.hooks;

afterEach(() => {
  fileMoveRemoteIo.exec = originalExec;
  fileMoveRemoteIo.hooks = originalHooks;
});

function stubExec(responder: (command: string) => Partial<SshExecResult>): { commands: string[] } {
  const commands: string[] = [];
  fileMoveRemoteIo.hooks = { buildSpec: async () => fakeSpec };
  fileMoveRemoteIo.exec = async (_spec, command) => {
    commands.push(command);
    return { stdout: new Uint8Array(), stderr: '', exitCode: 0, ...responder(command) };
  };
  return { commands };
}

describe('moveRemote', () => {
  test('sends one quoted command and maps status lines to outcomes', async () => {
    const { commands } = stubExec(() => ({
      stdout: enc('VTOP 0 ok\nVTOP 1 already_exists\n'),
    }));
    const result = await moveRemote(
      device,
      makeBatch([item('/srv/root', 'a b'), item('/srv/root', '-c')])
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("'a b'");
    expect(commands[0]).toContain("'-c'");
    expect(commands[0]).toContain('mv -f --');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toEqual({ ok: true, data: undefined });
    expect(result.data[1]).toMatchObject({ ok: false, code: 'already_exists' });
  });

  test('missing status line yields unknown for that item', async () => {
    stubExec(() => ({ stdout: enc('VTOP 0 ok\n') }));
    const result = await moveRemote(
      device,
      makeBatch([item('/srv/root', 'a'), item('/srv/root', 'b')])
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[1]).toMatchObject({ ok: false, code: 'unknown' });
  });

  test('exit 255 is connection_failed and exit 124 is timeout', async () => {
    stubExec(() => ({ exitCode: 255, stderr: 'ssh: connect to host x' }));
    const refused = await moveRemote(device, makeBatch([item('/srv/root', 'a')]));
    expect(refused).toMatchObject({ ok: false, code: 'connection_failed' });

    stubExec(() => ({ exitCode: 124 }));
    const slow = await moveRemote(device, makeBatch([item('/srv/root', 'a')]));
    expect(slow).toMatchObject({ ok: false, code: 'timeout' });
  });

  test('script exit codes map to request-level errors', async () => {
    const expected: Record<number, string> = {
      60: 'root_not_found',
      61: 'not_found',
      62: 'not_a_directory',
      63: 'permission_denied',
      64: 'outside_roots',
      7: 'unknown',
    };
    for (const [exitCode, code] of Object.entries(expected)) {
      stubExec(() => ({ exitCode: Number(exitCode) }));
      const result = await moveRemote(device, makeBatch([item('/srv/root', 'a')]));
      expect(result).toMatchObject({ ok: false, code });
    }
  });

  test('later chunk failure only marks its own items', async () => {
    let calls = 0;
    stubExec(() => {
      calls += 1;
      return calls === 1 ? { stdout: enc('VTOP 0 ok\n') } : { exitCode: 255 };
    });
    const many = Array.from({ length: 900 }, (_, i) => item('/srv/root', `${'y'.repeat(100)}${i}`));
    const result = await moveRemote(device, makeBatch(many));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(many.length);
    expect(calls).toBeGreaterThan(1);
    expect(result.data[0]).toEqual({ ok: true, data: undefined });
    expect(result.data.at(-1)).toMatchObject({ ok: false, code: 'connection_failed' });
  });
});

// 在本机真实执行脚本，验证 POSIX sh 语义
describe('script semantics (executed with sh)', () => {
  const sandboxes: string[] = [];

  afterEach(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
    sandboxes.length = 0;
  });

  function sandbox(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-move-sh-')));
    sandboxes.push(dir);
    mkdirSync(join(dir, 'dest'));
    return dir;
  }

  function run(batch: MoveBatch): { exitCode: number; statuses: Map<number, MoveStatus> } {
    const res = Bun.spawnSync(['sh', '-c', buildMoveScript(batch)]);
    return { exitCode: res.exitCode, statuses: parseMoveOutput(new Uint8Array(res.stdout)) };
  }

  function batchIn(dir: string, names: Array<[string, string?]>, over: Partial<MoveBatch> = {}) {
    return makeBatch(
      names.map(([name, destName]) => item(dir, name, destName)),
      { rootPath: dir, destRootPath: dir, destDir: join(dir, 'dest'), ...over }
    );
  }

  test('moves files with awkward names, including a leading dash and quotes', () => {
    const dir = sandbox();
    const names = ['-dash.txt', "it's here.txt", 'a b.txt'];
    for (const name of names) writeFileSync(join(dir, name), name);
    const entries = names.map((n): [string] => [n]);
    const { exitCode, statuses } = run(batchIn(dir, entries));
    expect(exitCode).toBe(0);
    expect([...statuses.values()]).toEqual(['ok', 'ok', 'ok']);
    for (const name of names) {
      expect(existsSync(join(dir, name))).toBe(false);
      expect(readFileSync(join(dir, 'dest', name), 'utf8')).toBe(name);
    }
  });

  test('same parent and name is a no-op; rename within the parent works', () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'a.txt'), 'a');
    const noop = run(batchIn(dir, [['a.txt']], { destDir: dir }));
    expect(noop.statuses.get(0)).toBe('ok');
    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
    const renamed = run(batchIn(dir, [['a.txt', 'b.txt']], { destDir: dir }));
    expect(renamed.statuses.get(0)).toBe('ok');
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('a');
  });

  test('conflict, overwrite rules and directory protection', () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    mkdirSync(join(dir, 'd'));
    mkdirSync(join(dir, 'dest', 'd'));
    writeFileSync(join(dir, 'g'), 'g');
    mkdirSync(join(dir, 'dest', 'g'));

    const failing = run(batchIn(dir, [['f']]));
    expect(failing.statuses.get(0)).toBe('already_exists');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');

    const over = run(batchIn(dir, [['f'], ['d'], ['g']], { overwrite: true }));
    expect(over.statuses.get(0)).toBe('ok');
    expect(over.statuses.get(1)).toBe('already_exists');
    expect(over.statuses.get(2)).toBe('already_exists');
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'd'))).toBe(true);
  });

  test('overwriting a symlink to a directory replaces the link, not the target content', () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'dest', 'f'));
    writeFileSync(join(dir, 'f'), 'new');
    const { statuses } = run(batchIn(dir, [['f']], { overwrite: true }));
    expect(statuses.get(0)).toBe('ok');
    expect(lstatSync(join(dir, 'dest', 'f')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'target', 'f'))).toBe(false);
  });

  test('directory into itself or a descendant is invalid', () => {
    const dir = sandbox();
    mkdirSync(join(dir, 'dest', 'inner'), { recursive: true });
    const self = run(batchIn(dir, [['dest']], { destDir: join(dir, 'dest') }));
    expect(self.statuses.get(0)).toBe('invalid');
    const deep = run(batchIn(dir, [['dest']], { destDir: join(dir, 'dest', 'inner') }));
    expect(deep.statuses.get(0)).toBe('invalid');
    expect(existsSync(join(dir, 'dest', 'inner'))).toBe(true);
  });

  test('symlinks are moved as links and missing sources report not_found', () => {
    const dir = sandbox();
    writeFileSync(join(dir, 'real'), 'x');
    symlinkSync('real', join(dir, 'ln'));
    const { statuses } = run(batchIn(dir, [['ln'], ['ghost']]));
    expect(statuses.get(0)).toBe('ok');
    expect(statuses.get(1)).toBe('not_found');
    expect(readlinkSync(join(dir, 'dest', 'ln'))).toBe('real');
    expect(readFileSync(join(dir, 'real'), 'utf8')).toBe('x');
  });

  test('source parent escaping the root through a symlink is outside_roots', () => {
    const dir = sandbox();
    const outside = sandbox();
    writeFileSync(join(outside, 'secret'), 's');
    symlinkSync(outside, join(dir, 'link'));
    const batch = makeBatch([item(join(dir, 'link'), 'secret')], {
      rootPath: dir,
      destRootPath: dir,
      destDir: join(dir, 'dest'),
    });
    const { statuses } = run(batch);
    expect(statuses.get(0)).toBe('outside_roots');
    expect(existsSync(join(outside, 'secret'))).toBe(true);
  });

  test('request-level exit codes for destDir problems', () => {
    const dir = sandbox();
    const outside = sandbox();
    writeFileSync(join(dir, 'file'), 'x');
    symlinkSync(outside, join(dir, 'esc'));
    const base = { rootPath: dir, destRootPath: dir };
    const missing = run(makeBatch([item(dir, 'file')], { ...base, destDir: join(dir, 'nope') }));
    expect(missing.exitCode).toBe(61);
    const notDir = run(makeBatch([item(dir, 'file')], { ...base, destDir: join(dir, 'file') }));
    expect(notDir.exitCode).toBe(62);
    const escaped = run(makeBatch([item(dir, 'file')], { ...base, destDir: join(dir, 'esc') }));
    expect(escaped.exitCode).toBe(64);
    const noRoot = run(makeBatch([item(dir, 'file')], { ...base, rootPath: join(dir, 'gone') }));
    expect(noRoot.exitCode).toBe(60);
    expect(existsSync(join(dir, 'file'))).toBe(true);
  });
});
