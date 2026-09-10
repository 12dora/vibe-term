import { describe, expect, test } from 'bun:test';
import {
  ByteCollector,
  IdleWatcher,
  createRunSentinel,
  dropEchoedCommandLine,
  formatRunOutput,
} from './term-collect';

const encoder = new TextEncoder();

describe('ByteCollector', () => {
  test('concatenates chunks and scrubs them on demand', () => {
    const collector = new ByteCollector();
    collector.append(encoder.encode('ab'));
    collector.append(encoder.encode('cd'));
    expect(collector.byteLength).toBe(4);
    expect(collector.text()).toBe('abcd');
    collector.reset();
    expect(collector.byteLength).toBe(0);
  });

  test('copies the frame so a reused gateway buffer cannot mutate it', () => {
    const collector = new ByteCollector();
    const frame = encoder.encode('xy');
    collector.append(frame);
    frame[0] = 0x7a;
    expect(collector.text()).toBe('xy');
  });
});

describe('IdleWatcher', () => {
  test('ends on silence once the idle window elapses', async () => {
    const watcher = new IdleWatcher({ idleMs: 20, timeoutMs: 1_000 });
    expect(await watcher.wait()).toBe('idle');
  });

  test('ends on the total timeout while data keeps arriving', async () => {
    const watcher = new IdleWatcher({ idleMs: 200, timeoutMs: 60 });
    const ticker = setInterval(() => watcher.note(), 10);
    const reason = await watcher.wait();
    clearInterval(ticker);
    expect(reason).toBe('timeout');
  });

  test('done() ends it early', async () => {
    const watcher = new IdleWatcher({ idleMs: 500, timeoutMs: 5_000 });
    setTimeout(() => watcher.done(), 10);
    expect(await watcher.wait()).toBe('done');
  });
});

describe('run sentinel', () => {
  test('matches the echoed result but not the typed $? form', () => {
    const sentinel = createRunSentinel('abc123');
    expect(sentinel.suffix).toBe('; echo __VT_DONE_abc123_$?');
    expect(sentinel.find('ls; echo __VT_DONE_abc123_$?')).toBeNull();
    expect(sentinel.find('__VT_DONE_abc123_7')).toEqual({
      exitCode: 7,
      line: '__VT_DONE_abc123_7',
    });
  });

  test('a different nonce never matches', () => {
    expect(createRunSentinel('aaa').find('__VT_DONE_bbb_0')).toBeNull();
  });
});

describe('formatRunOutput', () => {
  test('drops the echoed command line up to the first newline', () => {
    const raw = encoder.encode('e\becho hi\r\r\nhi\r\n');
    expect(dropEchoedCommandLine(raw)).toEqual(encoder.encode('hi\r\n'));
    expect(formatRunOutput(raw)).toBe('hi');
  });

  test('cuts at the sentinel line', () => {
    const sentinel = createRunSentinel('n1');
    const raw = encoder.encode('cmd\r\nout\r\n__VT_DONE_n1_0\r\nuser@host $ ');
    expect(formatRunOutput(raw, { sentinel })).toBe('out');
  });

  test('drops a trailing prompt when there is no sentinel', () => {
    const raw = encoder.encode('cmd\r\nout\r\nuser@host ~ % ');
    expect(formatRunOutput(raw)).toBe('out');
  });

  test('keeps a trailing line that does not look like a prompt', () => {
    const raw = encoder.encode('cmd\r\nout\r\nno newline here');
    expect(formatRunOutput(raw)).toBe('out\nno newline here');
  });
});
