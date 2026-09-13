import { afterEach, describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { captureDiagnostics } from './output';

const originalLog = console.log;
const originalInfo = console.info;
const originalDebug = console.debug;

afterEach(() => {
  console.log = originalLog;
  console.info = originalInfo;
  console.debug = originalDebug;
});

function sink(): { stream: Writable; text(): string } {
  const chunks: Buffer[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
      },
    }),
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

describe('captureDiagnostics', () => {
  test('drops console.log in silent (json/quiet/non-TTY) mode', () => {
    const out = sink();
    captureDiagnostics(true, out.stream);
    console.log('[borsh-client] State: CONNECTING -> READY');
    expect(out.text()).toBe('');
  });

  test('writes console.log to stderr in human TTY mode', () => {
    const out = sink();
    captureDiagnostics(false, out.stream);
    console.log('[borsh-client] State: CONNECTING -> READY');
    expect(out.text()).toBe('[borsh-client] State: CONNECTING -> READY\n');
  });
});
