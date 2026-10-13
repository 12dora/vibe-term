import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  type ArchiveProcess,
  createArchiveStream,
  createArchiveStreamFromProcess,
  fileArchiveIo,
  tarArchiveArgs,
  tarNameArgs,
} from './archive-stream';

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

describe('idle timeout covers the whole stream lifetime', () => {
  test('a consumer that stops reading (back-pressure) trips the idle kill', async () => {
    silenceWarn();
    const stub = stubProcess();
    install(stub);
    const onClose = mock(() => {});
    const stream = createArchiveStream({ argv: ['tar'], maxBytes: 1024, idleMs: 40, onClose });
    const reader = stream.getReader();

    stub.push('a');
    stub.push('b');
    expect((await reader.read()).done).toBe(false);
    await Bun.sleep(150);

    expect(stub.kill).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(reader.read()).rejects.toThrow('archive_idle_timeout');
  });

  test('a steady consumer never trips the timer even when the total exceeds idleMs', async () => {
    const stub = stubProcess();
    install(stub);
    const onClose = mock(() => {});
    const stream = createArchiveStream({ argv: ['tar'], maxBytes: 1024, idleMs: 150, onClose });

    const text = new Response(stream).text();
    for (let i = 0; i < 8; i++) {
      stub.push(String(i));
      await Bun.sleep(30);
    }
    stub.end(0);

    expect(await text).toBe('01234567');
    expect(stub.kill).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('cancel disarms the timer: no second close or kill afterwards', async () => {
    const stub = stubProcess();
    install(stub);
    const onClose = mock(() => {});
    const stream = createArchiveStream({ argv: ['tar'], maxBytes: 1024, idleMs: 30, onClose });
    const reader = stream.getReader();

    stub.push('x');
    await reader.read();
    await reader.cancel();
    await Bun.sleep(100);

    expect(stub.kill).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('createArchiveStreamFromProcess wraps an already started process', async () => {
    const stub = stubProcess();
    const onClose = mock(() => {});
    const stream = createArchiveStreamFromProcess(stub.proc, { maxBytes: 1024, onClose });

    const text = new Response(stream).text();
    stub.push('ok');
    stub.end(0);

    expect(await text).toBe('ok');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('tar argument builders', () => {
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

  test('the dot entry archives the working directory itself', () => {
    expect(tarArchiveArgs('/', ['.'])).toEqual(['tar', '-czf', '-', '-C', '/', '.']);
    expect(tarNameArgs(['.'])).toEqual(['.']);
  });
});
