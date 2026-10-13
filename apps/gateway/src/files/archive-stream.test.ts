import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  type ArchiveProcess,
  buildSshInvocation,
  createArchiveStream,
  fileArchiveIo,
  tarArchiveArgs,
} from './archive-stream';
import type { RsyncDeviceSpec } from './ssh-command';

const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

const encoder = new TextEncoder();

function stubProcess(stderrText = '') {
  let stdoutCtl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutCtl = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stderrText) controller.enqueue(encoder.encode(stderrText));
      controller.close();
    },
  });
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const closeStdout = () => {
    try {
      stdoutCtl?.close();
    } catch {
      // 已被取消
    }
  };
  const kill = mock(() => {
    resolveExit(137);
    closeStdout();
  });
  const proc: ArchiveProcess = { stdout, stderr, exited, kill };
  return {
    proc,
    kill,
    push: (text: string) => stdoutCtl?.enqueue(encoder.encode(text)),
    end: (code: number) => {
      closeStdout();
      resolveExit(code);
    },
  };
}

function install(stub: ReturnType<typeof stubProcess>) {
  const spy = spyOn(fileArchiveIo, 'spawn').mockImplementation(() => stub.proc);
  spies.push(spy);
  return spy;
}

function silenceWarn() {
  const spy = spyOn(console, 'warn').mockImplementation(() => {});
  spies.push(spy);
  return spy;
}

describe('createArchiveStream', () => {
  test('streams stdout and closes after a zero exit', async () => {
    const stub = stubProcess();
    install(stub);
    const onClose = mock(() => {});
    const stream = createArchiveStream({ argv: ['tar'], maxBytes: 1024, onClose });

    const text = new Response(stream).text();
    stub.push('abc');
    stub.push('def');
    stub.end(0);

    expect(await text).toBe('abcdef');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stub.kill).not.toHaveBeenCalled();
  });

  test('errors the stream on a non-zero exit and logs the stderr tail', async () => {
    const warn = silenceWarn();
    const stub = stubProcess('tar: boom');
    install(stub);
    const onClose = mock(() => {});
    const stream = createArchiveStream({ argv: ['tar'], maxBytes: 1024, onClose });

    const text = new Response(stream).text();
    stub.push('abc');
    stub.end(2);

    await expect(text).rejects.toThrow('archive_exit_2');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('tar: boom');
  });

  test('cancel kills the process and runs onClose once', async () => {
    const stub = stubProcess();
    install(stub);
    const onClose = mock(() => {});
    const stream = createArchiveStream({ argv: ['tar'], maxBytes: 1024, onClose });
    const reader = stream.getReader();

    stub.push('x');
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();

    expect(stub.kill).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('kills and errors once the byte cap is exceeded', async () => {
    silenceWarn();
    const stub = stubProcess();
    install(stub);
    const onClose = mock(() => {});
    const stream = createArchiveStream({ argv: ['tar'], maxBytes: 5, onClose });

    const text = new Response(stream).text();
    stub.push('abcdefgh');

    await expect(text).rejects.toThrow('archive_too_large');
    expect(stub.kill).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('kills and errors after the idle timeout without output', async () => {
    silenceWarn();
    const stub = stubProcess();
    install(stub);
    const onClose = mock(() => {});
    const stream = createArchiveStream({ argv: ['tar'], maxBytes: 1024, idleMs: 20, onClose });

    await expect(new Response(stream).text()).rejects.toThrow('archive_idle_timeout');
    expect(stub.kill).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('runs onClose and rethrows when spawn fails', () => {
    const spy = spyOn(fileArchiveIo, 'spawn').mockImplementation(() => {
      throw new Error('spawn failed');
    });
    spies.push(spy);
    const onClose = mock(() => {});

    expect(() => createArchiveStream({ argv: ['tar'], maxBytes: 1, onClose })).toThrow(
      'spawn failed'
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('passes argv and env to spawn', () => {
    const stub = stubProcess();
    const spy = install(stub);

    createArchiveStream({ argv: ['a', 'b'], env: { K: 'v' }, maxBytes: 1 });

    expect(spy).toHaveBeenCalledWith(['a', 'b'], { K: 'v' });
    stub.end(0);
  });
});

describe('argv builders', () => {
  test('tarArchiveArgs prefixes names with ./ so leading dashes are not options', () => {
    expect(tarArchiveArgs('/data/dir', ['-rf', 'a b'])).toEqual([
      'tar',
      '-czf',
      '-',
      '-C',
      '/data/dir',
      './-rf',
      './a b',
    ]);
  });

  test('buildSshInvocation quotes the remote command and merges spec env', () => {
    const spec: RsyncDeviceSpec = {
      targetPrefix: 'user@host:',
      rsh: 'ssh -o BatchMode=yes -i /k',
      env: { SSH_AUTH_SOCK: '/sock' },
      cleanup: () => {},
    };

    const invocation = buildSshInvocation(spec, tarArchiveArgs("/p/it's", ['x y']));

    expect(invocation?.argv.slice(0, 5)).toEqual(['ssh', '-o', 'BatchMode=yes', '-i', '/k']);
    expect(invocation?.argv[5]).toBe('user@host');
    expect(invocation?.argv[6]).toBe("'tar' '-czf' '-' '-C' '/p/it'\\''s' './x y'");
    expect(invocation?.env.SSH_AUTH_SOCK).toBe('/sock');
  });

  test('buildSshInvocation returns null for a non-ssh spec', () => {
    const spec: RsyncDeviceSpec = { targetPrefix: '', rsh: undefined, env: {}, cleanup: () => {} };
    expect(buildSshInvocation(spec, ['tar'])).toBeNull();
  });
});
