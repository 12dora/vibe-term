import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  buildMoveScript,
  fileMoveRemoteIo,
  moveRemote,
  outcomesFromStatuses,
  parseMoveOutput,
} from './move-remote';
import type { MoveBatch, MoveItem } from './move-types';
import { remoteScriptIo } from './remote-script';
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
    expect(script).toContain('mv -n $T -- "$s" "$1"');
    expect(script).toContain('s="./$n"');
    expect(script).toContain('ow=0');
  });

  test('physical paths come from phys, never from a command substitution', () => {
    const script = buildMoveScript(makeBatch([item('/srv/root', 'a')]));
    expect(script).toContain('phys()');
    expect(script).toContain('inside()');
    expect(script).not.toContain('$(pwd -P)');
    expect(script).not.toContain('sh -c');
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
const originalSpawn = remoteScriptIo.spawn;

afterEach(() => {
  fileMoveRemoteIo.exec = originalExec;
  fileMoveRemoteIo.hooks = originalHooks;
  remoteScriptIo.spawn = originalSpawn;
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
    expect(commands[0]).toContain('mv -n $T --');
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
});

// 脚本经 `sh -s` 在本机真实执行（把 remoteScriptIo.spawn 换成本机 sh），验证 POSIX sh 语义
describe('script semantics (executed with sh -s)', () => {
  const sandboxes: string[] = [];
  const isRoot = process.getuid?.() === 0;

  afterEach(() => {
    for (const dir of sandboxes) {
      rmSync(dir, { recursive: true, force: true });
    }
    sandboxes.length = 0;
  });

  function sandbox(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vibeterm-move-sh-')));
    sandboxes.push(dir);
    mkdirSync(join(dir, 'dest'));
    return dir;
  }

  interface Call {
    argv: string[];
    script: string;
  }

  /** `transform` 用来在脚本里模拟竞态（例如让存在性预检看到「不存在」）。 */
  function viaLocalSh(transform: (script: string) => string = (script) => script): Call[] {
    const calls: Call[] = [];
    fileMoveRemoteIo.hooks = { buildSpec: async () => fakeSpec };
    remoteScriptIo.spawn = (argv, env, script) => {
      calls.push({ argv, script });
      return originalSpawn(['sh', '-s'], env, transform(script));
    };
    return calls;
  }

  interface RunResult {
    request?: string;
    statuses: string[];
  }

  async function run(batch: MoveBatch): Promise<RunResult> {
    const result = await moveRemote(device, batch);
    if (!result.ok) return { request: result.code, statuses: [] };
    return { statuses: result.data.map((o) => (o.ok ? 'ok' : o.code)) };
  }

  function batchIn(dir: string, names: Array<[string, string?]>, over: Partial<MoveBatch> = {}) {
    return makeBatch(
      names.map(([name, destName]) => item(dir, name, destName)),
      { rootPath: dir, destRootPath: dir, destDir: join(dir, 'dest'), ...over }
    );
  }

  test('moves files with awkward names, including a leading dash and quotes', async () => {
    viaLocalSh();
    const dir = sandbox();
    const names = ['-dash.txt', "it's here.txt", 'a b.txt'];
    for (const name of names) writeFileSync(join(dir, name), name);
    const { request, statuses } = await run(
      batchIn(
        dir,
        names.map((n): [string] => [n])
      )
    );
    expect(request).toBeUndefined();
    expect(statuses).toEqual(['ok', 'ok', 'ok']);
    for (const name of names) {
      expect(existsSync(join(dir, name))).toBe(false);
      expect(readFileSync(join(dir, 'dest', name), 'utf8')).toBe(name);
    }
  });

  test('same parent and name is a no-op; rename within the parent works', async () => {
    viaLocalSh();
    const dir = sandbox();
    writeFileSync(join(dir, 'a.txt'), 'a');
    const noop = await run(batchIn(dir, [['a.txt']], { destDir: dir }));
    expect(noop.statuses).toEqual(['ok']);
    expect(existsSync(join(dir, 'a.txt'))).toBe(true);
    const renamed = await run(batchIn(dir, [['a.txt', 'b.txt']], { destDir: dir }));
    expect(renamed.statuses).toEqual(['ok']);
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('a');
  });

  test('conflict, overwrite rules and directory protection', async () => {
    viaLocalSh();
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    mkdirSync(join(dir, 'd'));
    mkdirSync(join(dir, 'dest', 'd'));
    writeFileSync(join(dir, 'g'), 'g');
    mkdirSync(join(dir, 'dest', 'g'));

    const failing = await run(batchIn(dir, [['f']]));
    expect(failing.statuses).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');

    const over = await run(batchIn(dir, [['f'], ['d'], ['g']], { overwrite: true }));
    expect(over.statuses).toEqual(['ok', 'already_exists', 'already_exists']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'd'))).toBe(true);
    expect(readdirSync(join(dir, 'dest', 'd'))).toEqual([]);
  });

  test('no-replace holds when the pre-check is fooled (file and directory)', async () => {
    // 把预检 `gone "$dp"` 换成恒真，等价于「检查之后目标才被别人建出来」
    viaLocalSh((script) => script.replace('if gone "$dp"; then mvn', 'if true; then mvn'));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    writeFileSync(join(dir, 'dest', 'f'), 'old');
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'src-inner'), 'src');
    mkdirSync(join(dir, 'dest', 'd'));
    writeFileSync(join(dir, 'dest', 'd', 'keep'), 'keep');

    const { statuses } = await run(batchIn(dir, [['f'], ['d']]));

    expect(statuses).toEqual(['already_exists', 'already_exists']);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('old');
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(readdirSync(join(dir, 'dest', 'd'))).toEqual(['keep']);
    expect(readFileSync(join(dir, 'd', 'src-inner'), 'utf8')).toBe('src');
  });

  test('rename onto an existing sibling keeps both files', async () => {
    viaLocalSh((script) => script.replace('if gone "$dp"; then mvn', 'if true; then mvn'));
    const dir = sandbox();
    writeFileSync(join(dir, 'a'), 'a');
    writeFileSync(join(dir, 'b'), 'b');

    const { statuses } = await run(batchIn(dir, [['a', 'b']], { destDir: dir }));

    expect(statuses).toEqual(['already_exists']);
    expect(readFileSync(join(dir, 'a'), 'utf8')).toBe('a');
    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('b');
  });

  test('overwriting a symlink to a directory replaces the link only', async () => {
    viaLocalSh();
    const dir = sandbox();
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'dest', 'f'));
    writeFileSync(join(dir, 'f'), 'new');
    const { statuses } = await run(batchIn(dir, [['f']], { overwrite: true }));
    expect(statuses).toEqual(['ok']);
    expect(lstatSync(join(dir, 'dest', 'f')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'dest', 'f'), 'utf8')).toBe('new');
    expect(readdirSync(join(dir, 'target'))).toEqual([]);
    expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
  });

  test.skipIf(isRoot)('an unmovable source leaves the old destination symlink alone', async () => {
    viaLocalSh();
    const dir = sandbox();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'f'), 'new');
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'dest', 'f'));
    chmodSync(join(dir, 'src'), 0o555);
    try {
      const batch = makeBatch([item(join(dir, 'src'), 'f')], {
        rootPath: dir,
        destRootPath: dir,
        destDir: join(dir, 'dest'),
        overwrite: true,
      });
      const { statuses } = await run(batch);
      expect(statuses).toEqual(['permission_denied']);
    } finally {
      chmodSync(join(dir, 'src'), 0o755);
    }
    expect(readlinkSync(join(dir, 'dest', 'f'))).toBe(join(dir, 'target'));
    expect(readFileSync(join(dir, 'src', 'f'), 'utf8')).toBe('new');
    expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
  });

  test('a failed final replace puts the source back and keeps the old symlink', async () => {
    // rm 失败 = 换链接这一步没成功；此时源已被挪到临时名，必须原样放回
    viaLocalSh((script) => script.replace('e=$(rm -f -- "$dp" 2>&1 </dev/null)', 'e=$(false)'));
    const dir = sandbox();
    writeFileSync(join(dir, 'f'), 'new');
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'dest', 'f'));

    const { statuses } = await run(batchIn(dir, [['f']], { overwrite: true }));

    expect(statuses).toEqual(['unknown']);
    expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('new');
    expect(readlinkSync(join(dir, 'dest', 'f'))).toBe(join(dir, 'target'));
    expect(readdirSync(join(dir, 'dest'))).toEqual(['f']);
  });

  test('directory into itself or a descendant is invalid', async () => {
    viaLocalSh();
    const dir = sandbox();
    mkdirSync(join(dir, 'dest', 'inner'), { recursive: true });
    const self = await run(batchIn(dir, [['dest']], { destDir: join(dir, 'dest') }));
    expect(self.statuses).toEqual(['invalid']);
    const deep = await run(batchIn(dir, [['dest']], { destDir: join(dir, 'dest', 'inner') }));
    expect(deep.statuses).toEqual(['invalid']);
    expect(existsSync(join(dir, 'dest', 'inner'))).toBe(true);
  });

  test('symlinks are moved as links and missing sources report not_found', async () => {
    viaLocalSh();
    const dir = sandbox();
    writeFileSync(join(dir, 'real'), 'x');
    symlinkSync('real', join(dir, 'ln'));
    const { statuses } = await run(batchIn(dir, [['ln'], ['ghost']]));
    expect(statuses).toEqual(['ok', 'not_found']);
    expect(readlinkSync(join(dir, 'dest', 'ln'))).toBe('real');
    expect(readFileSync(join(dir, 'real'), 'utf8')).toBe('x');
  });

  test('source parent escaping the root through a symlink is outside_roots', async () => {
    viaLocalSh();
    const dir = sandbox();
    const outside = sandbox();
    writeFileSync(join(outside, 'secret'), 's');
    symlinkSync(outside, join(dir, 'link'));
    const batch = makeBatch([item(join(dir, 'link'), 'secret')], {
      rootPath: dir,
      destRootPath: dir,
      destDir: join(dir, 'dest'),
    });
    const { statuses } = await run(batch);
    expect(statuses).toEqual(['outside_roots']);
    expect(existsSync(join(outside, 'secret'))).toBe(true);
  });

  test('request-level errors for destDir problems', async () => {
    viaLocalSh();
    const dir = sandbox();
    const outside = sandbox();
    writeFileSync(join(dir, 'file'), 'x');
    symlinkSync(outside, join(dir, 'esc'));
    const base = { rootPath: dir, destRootPath: dir };
    const attempt = async (over: Partial<MoveBatch>) =>
      (await run(makeBatch([item(dir, 'file')], { ...base, ...over }))).request;
    expect(await attempt({ destDir: join(dir, 'nope') })).toBe('not_found');
    expect(await attempt({ destDir: join(dir, 'file') })).toBe('not_a_directory');
    expect(await attempt({ destDir: join(dir, 'esc') })).toBe('outside_roots');
    expect(await attempt({ rootPath: join(dir, 'gone') })).toBe('root_not_found');
    expect(existsSync(join(dir, 'file'))).toBe(true);
  });

  test('a destination ending in a newline is not confused with its sibling', async () => {
    viaLocalSh();
    const dir = sandbox();
    const outside = sandbox();
    rmSync(join(dir, 'dest'), { recursive: true });
    symlinkSync(outside, join(dir, 'dest'));
    mkdirSync(join(dir, 'dest\n'));
    writeFileSync(join(dir, 'f'), 'f');
    writeFileSync(join(dir, 'g'), 'g');

    const real = await run(batchIn(dir, [['f']], { destDir: join(dir, 'dest\n') }));
    expect(real.statuses).toEqual(['ok']);
    expect(readFileSync(join(dir, 'dest\n', 'f'), 'utf8')).toBe('f');

    const sibling = await run(batchIn(dir, [['g']], { destDir: join(dir, 'dest') }));
    expect(sibling.request).toBe('outside_roots');
    expect(readdirSync(outside)).toEqual(['dest']);
    expect(existsSync(join(dir, 'g'))).toBe(true);
  });

  test('a root ending in a newline is not confused with its sibling', async () => {
    viaLocalSh();
    const dir = sandbox();
    const outside = sandbox();
    mkdirSync(join(dir, 'r\n'));
    writeFileSync(join(dir, 'r\n', 'x'), 'inside');
    symlinkSync(outside, join(dir, 'r'));
    writeFileSync(join(outside, 'x'), 'secret');
    const base = { rootPath: join(dir, 'r\n'), destRootPath: dir };

    const real = await run(makeBatch([item(join(dir, 'r\n'), 'x')], { ...base, destDir: dir }));
    expect(real.statuses).toEqual(['ok']);
    expect(readFileSync(join(dir, 'x'), 'utf8')).toBe('inside');

    const sibling = await run(makeBatch([item(join(dir, 'r'), 'x')], { ...base, destDir: dir }));
    expect(sibling.statuses).toEqual(['outside_roots']);
    expect(readFileSync(join(outside, 'x'), 'utf8')).toBe('secret');
  });

  test('500 long names go out in a single round trip with the script on stdin', async () => {
    const calls = viaLocalSh();
    const dir = sandbox();
    const names = Array.from({ length: 500 }, (_, i) => `${'n'.repeat(200)}-${i}`);

    const { request, statuses } = await run(
      batchIn(
        dir,
        names.map((n): [string] => [n])
      )
    );

    expect(request).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv.at(-1)).toBe('sh -s');
    expect(calls[0]?.script.length).toBeGreaterThan(128 * 1024);
    expect(statuses).toHaveLength(500);
    expect(new Set(statuses)).toEqual(new Set(['not_found']));
  });
});
