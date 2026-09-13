import { describe, expect, test } from 'bun:test';
import {
  ByteCollector,
  IdleWatcher,
  createRunSentinel,
  formatRunOutput,
  looksEchoed,
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

  test('stops collecting at the cap and reports the truncation', () => {
    const collector = new ByteCollector(4);
    expect(collector.append(encoder.encode('ab'))).toBe(true);
    expect(collector.append(encoder.encode('cdef'))).toBe(false);
    expect(collector.truncated).toBe(true);
    expect(collector.byteLength).toBe(4);
    expect(collector.text()).toBe('abcd');
    expect(collector.append(encoder.encode('gh'))).toBe(false);
    expect(collector.byteLength).toBe(4);
    collector.reset();
    expect(collector.truncated).toBe(false);
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

  test('requireActivity times out when no note() arrives', async () => {
    const watcher = new IdleWatcher({ idleMs: 20, timeoutMs: 60, requireActivity: true });
    expect(await watcher.wait()).toBe('timeout');
  });

  test('requireActivity idles after the first note plus silence', async () => {
    const watcher = new IdleWatcher({ idleMs: 20, timeoutMs: 1_000, requireActivity: true });
    setTimeout(() => watcher.note(), 10);
    expect(await watcher.wait()).toBe('idle');
  });
});

describe('run sentinel', () => {
  test('is typed as its own line and matches only the numeric result', () => {
    const sentinel = createRunSentinel('abc123');
    expect(sentinel.line).toBe('(echo __VT_DONE_abc123_$?)');
    expect(sentinel.find('(echo __VT_DONE_abc123_$?)')).toBeNull();
    expect(sentinel.mentions('(echo __VT_DONE_abc123_$?)')).toBe(true);
    expect(sentinel.find('__VT_DONE_abc123_7')).toEqual({
      exitCode: 7,
      line: '__VT_DONE_abc123_7',
    });
  });

  test('a different nonce never matches', () => {
    expect(createRunSentinel('aaa').find('__VT_DONE_bbb_0')).toBeNull();
    expect(createRunSentinel('aaa').mentions('__VT_DONE_bbb_0')).toBe(false);
  });
});

describe('formatRunOutput', () => {
  test('drops the echoed command line up to the first newline', () => {
    const raw = encoder.encode('e\becho hi\r\r\nhi\r\n');
    expect(formatRunOutput(raw, { command: 'echo hi' })).toBe('hi');
  });

  test('keeps the first line when the pane did not echo it', () => {
    const raw = encoder.encode('Darwin\r\nuser@host ~ % ');
    expect(formatRunOutput(raw, { command: 'uname -s' })).toBe('Darwin');
  });

  test('cuts at the echoed sentinel line, not only at its result', () => {
    const sentinel = createRunSentinel('n1');
    const raw = encoder.encode(
      `echo hi\r\nout\r\n(echo ${sentinel.token}$?)\r\n${sentinel.token}0\r\nuser@host $ `
    );
    expect(formatRunOutput(raw, { command: 'echo hi', sentinel })).toBe('out');
  });

  test('drops a trailing prompt when there is no sentinel', () => {
    const raw = encoder.encode('cmd\r\nout\r\nuser@host ~ % ');
    expect(formatRunOutput(raw, { command: 'cmd' })).toBe('out');
  });

  test('keeps a trailing line that does not look like a prompt', () => {
    const raw = encoder.encode('cmd\r\nout\r\nno newline here');
    expect(formatRunOutput(raw, { command: 'cmd' })).toBe('out\nno newline here');
  });

  test('strips a multi-line bracketed-paste echo block from paste output', () => {
    const script = 'echo a\necho b\necho c';
    const raw = encoder.encode(`\x1b[200~${script}\x1b[201~\ra\nb\nc\nuser@host $ `);
    expect(formatRunOutput(raw, { command: script, paste: true })).toBe('a\nb\nc');
  });

  test('strips leading echoed script lines when the pane did not echo CSI', () => {
    const script = 'echo a\necho b\necho c';
    const raw = encoder.encode(`${script}\na\nb\nc\nuser@host $ `);
    expect(formatRunOutput(raw, { command: script, paste: true })).toBe('a\nb\nc');
  });

  test('does not eat short real output as a paste echo', () => {
    const script = 'echo a\necho b\necho c';
    const raw = encoder.encode('a\nb\nc\nuser@host $ ');
    expect(formatRunOutput(raw, { command: script, paste: true })).toBe('a\nb\nc');
  });

  test('strips caret-notation paste echo plus prompt-line ZLE echo', () => {
    const script = 'echo a\necho b';
    const raw = encoder.encode(
      '^[[200~echo a\r\necho b^[[201~\r\nkonata@host ~ % echo a\necho b   echo a\na\nb'
    );
    expect(formatRunOutput(raw, { command: script, paste: true })).toBe('a\nb');
  });

  test('strips a prompt line that ends with the first script line', () => {
    const script = 'echo a\necho b';
    const raw = encoder.encode('konata@host ~ % echo a\necho b   echo a\na\nb\n');
    expect(formatRunOutput(raw, { command: script, paste: true })).toBe('a\nb');
  });
});

describe('looksEchoed', () => {
  test('recognises a mangled echo as a subsequence of the command', () => {
    expect(looksEchoed('li', 'echo hello-cli')).toBe(true);
    expect(looksEchoed('echo hello-cli', 'echo hello-cli')).toBe(true);
    expect(looksEchoed('', 'echo hi')).toBe(true);
  });

  test('does not mistake real output for an echo', () => {
    expect(looksEchoed('Darwin', 'uname -s')).toBe(false);
    expect(looksEchoed('total 128', 'ls -l')).toBe(false);
  });
});
