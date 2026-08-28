import { describe, expect, test } from 'bun:test';
import { OUTPUT_MAX_BYTES, createByteOutputBuffer } from './run-command-buffer';

const enc = new TextEncoder();

describe('createByteOutputBuffer', () => {
  test('按字节累积并可 decode', () => {
    const buf = createByteOutputBuffer();
    buf.append(enc.encode('hello '));
    buf.append(enc.encode('世界'));
    expect(buf.decode()).toBe('hello 世界');
    expect(buf.wasTruncated()).toBe(false);
  });

  test('超过上限按字节截断并标记 truncated', () => {
    const buf = createByteOutputBuffer(8);
    buf.append(enc.encode('abcdefghijkl'));
    expect(buf.wasTruncated()).toBe(true);
    expect(buf.decode()).toBe('abcdefgh');
  });

  test('多字节 UTF-8 在字节上限处截断', () => {
    const buf = createByteOutputBuffer(4);
    buf.append(enc.encode('你'));
    buf.append(enc.encode('好'));
    expect(buf.wasTruncated()).toBe(true);
    expect(buf.decode().startsWith('你')).toBe(true);
    expect(buf.decode()).not.toContain('好');
  });

  test('reset 清空内容与 truncated 标记', () => {
    const buf = createByteOutputBuffer(2);
    buf.append(enc.encode('abcdef'));
    expect(buf.wasTruncated()).toBe(true);
    buf.reset();
    expect(buf.decode()).toBe('');
    expect(buf.wasTruncated()).toBe(false);
    buf.append(enc.encode('ok'));
    expect(buf.decode()).toBe('ok');
    expect(buf.wasTruncated()).toBe(false);
  });

  test('默认上限为 256KiB', () => {
    expect(OUTPUT_MAX_BYTES).toBe(256 * 1024);
    const buf = createByteOutputBuffer();
    buf.append(new Uint8Array(OUTPUT_MAX_BYTES));
    expect(buf.wasTruncated()).toBe(false);
    buf.append(new Uint8Array([1]));
    expect(buf.wasTruncated()).toBe(true);
  });
});
