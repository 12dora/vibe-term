import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { runMigrations } from '../db/migrate';
import type { SshExecResult } from '../files/directory-browse';
import { fileMoveRemoteIo } from '../files/move-remote';
import {
  cleanupMoveTest,
  errorBody,
  move,
  newDevice,
  rename,
  rootOn,
} from './file-move-test-utils';

beforeAll(() => {
  runMigrations();
});

afterEach(cleanupMoveTest);

describe('ssh devices', () => {
  const fakeSpec = { targetPrefix: 'u@h:', rsh: 'ssh', env: {}, cleanup: () => {} };

  type Responder = Partial<SshExecResult> | ((command: string) => Partial<SshExecResult>);

  function stubSsh(responder: Responder) {
    const commands: string[] = [];
    fileMoveRemoteIo.hooks = { buildSpec: async () => fakeSpec };
    fileMoveRemoteIo.exec = async (_spec, command) => {
      commands.push(command);
      const partial = typeof responder === 'function' ? responder(command) : responder;
      return { stdout: new Uint8Array(), stderr: '', exitCode: 0, ...partial };
    };
    return commands;
  }

  const enc = (s: string) => new TextEncoder().encode(s);

  function sshRoot(): { rootId: string; path: string } {
    const path = '/remote/root';
    return { rootId: rootOn(newDevice('ssh'), path), path };
  }

  test('move runs one script and merges per-item statuses with local planning errors', async () => {
    const { rootId, path } = sshRoot();
    const commands = stubSsh({ stdout: enc('VTOP 0 ok\nVTOP 1 already_exists\n') });
    const paths = [`${path}/a b.txt`, `${path}/-c`, `${path}/../outside`, path];

    const { status, json } = await move({ rootId, paths, destDir: `${path}/dest dir` });

    expect(status).toBe(200);
    expect(json).toEqual({
      results: [
        { path: paths[0], ok: true, dest: `${path}/dest dir/a b.txt` },
        { path: paths[1], ok: false, code: 'already_exists' },
        { path: '/remote/outside', ok: false, code: 'outside_roots' },
        { path, ok: false, code: 'invalid' },
      ],
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("'/remote/root/dest dir'");
    expect(commands[0]).toContain("'a b.txt'");
    expect(commands[0]).toContain("'-c'");
    expect(commands[0]).toContain('mv -n $T --');
  });

  test('overwrite is passed to the script', async () => {
    const { rootId, path } = sshRoot();
    const commands = stubSsh({ stdout: enc('VTOP 0 ok\n') });

    await move({ rootId, paths: [`${path}/a`], destDir: path, onConflict: 'overwrite' });

    expect(commands[0]).toContain('ow=1');
    expect(commands[0]).toContain('if [ -n "$T" ] || [ ! -L "$dp" ]; then');
  });

  test('a request with only invalid items never contacts the host', async () => {
    const { rootId, path } = sshRoot();
    const commands = stubSsh({});

    const { status, json } = await move({ rootId, paths: [path], destDir: path });

    expect(status).toBe(200);
    expect(json).toEqual({ results: [{ path, ok: false, code: 'invalid' }] });
    expect(commands).toHaveLength(0);
  });

  test('connection and destination failures are request-level', async () => {
    const { rootId, path } = sshRoot();
    const paths = [`${path}/a`];
    const attempt = async (exitCode: number) => {
      stubSsh({ exitCode, stderr: 'boom' });
      return move({ rootId, paths, destDir: `${path}/dest` });
    };

    expect((await attempt(255)).status).toBe(502);
    expect((await attempt(124)).status).toBe(504);
    expect((await attempt(61)).json).toMatchObject({ code: 'not_found' });
    expect((await attempt(62)).json).toMatchObject({ code: 'not_a_directory' });
    expect((await attempt(64)).json).toMatchObject({ code: 'outside_roots' });
  });

  test('missing status lines surface as unknown', async () => {
    const { rootId, path } = sshRoot();
    stubSsh({ stdout: enc('') });

    const { json } = await move({ rootId, paths: [`${path}/a`], destDir: path });

    expect(json).toEqual({ results: [{ path: `${path}/a`, ok: false, code: 'unknown' }] });
  });

  test('rename sends the new name quoted and never overwrites', async () => {
    const { rootId, path } = sshRoot();
    const commands = stubSsh({ stdout: enc('VTOP 0 ok\n') });

    const ok = await rename({ rootId, path: `${path}/sub/old`, name: "new 'name'" });

    expect(ok).toEqual({ status: 200, json: { path: `${path}/sub/new 'name'` } });
    expect(commands[0]).toContain(`vt 0 '/remote/root/sub' 'old' 'new '\\''name'\\'''`);
    expect(commands[0]).not.toContain('sh -c');
    expect(commands[0]).toContain('ow=0');

    stubSsh({ stdout: enc('VTOP 0 already_exists\n') });
    const exists = await rename({ rootId, path: `${path}/sub/old`, name: 'taken' });
    expect(exists).toEqual({ status: 409, json: errorBody('already_exists') });
  });

  test('rename validates the name before contacting the host', async () => {
    const { rootId, path } = sshRoot();
    const commands = stubSsh({});

    const { status, json } = await rename({ rootId, path: `${path}/a`, name: 'x/y' });

    expect(status).toBe(400);
    expect(json).toEqual(errorBody('invalid'));
    expect(commands).toHaveLength(0);
  });
});
