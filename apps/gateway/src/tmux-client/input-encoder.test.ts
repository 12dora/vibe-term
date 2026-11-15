import { describe, expect, test } from 'bun:test';

import {
  SEND_KEYS_HEX_CHUNK_BYTES,
  buildSendKeysArgv,
  buildSendKeysCommands,
  encodeBytesToHexChunks,
  parseSendKeysHexArgv,
} from './input-encoder';

describe('input encoder', () => {
  test('encodes utf-8 input into tmux send-keys hex chunks', () => {
    expect(encodeBytesToHexChunks(new TextEncoder().encode('A中'))).toEqual([
      ['41', 'e4', 'b8', 'ad'],
    ]);
  });

  test('splits long payloads at 256 bytes to match tmux send-keys -H behavior', () => {
    const chunks = encodeBytesToHexChunks(
      new TextEncoder().encode('a'.repeat(SEND_KEYS_HEX_CHUNK_BYTES + 1))
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(SEND_KEYS_HEX_CHUNK_BYTES);
    expect(chunks[1]).toEqual(['61']);
  });

  test('preserves arbitrary canonical input bytes without a text round trip', () => {
    expect(encodeBytesToHexChunks(new Uint8Array([0x00, 0x80, 0xff]))).toEqual([
      ['00', '80', 'ff'],
    ]);
  });
});

describe('buildSendKeysCommands', () => {
  test('每条命令都是完整的 send-keys -H argv，块大小与 hex 编码一致', () => {
    const commands = buildSendKeysCommands('%1', new TextEncoder().encode('A中'));
    expect(commands).toEqual([['send-keys', '-H', '-t', '%1', '41', 'e4', 'b8', 'ad']]);
  });

  test('长输入按 SEND_KEYS_HEX_CHUNK_BYTES 切块，命令实参长度不超过 1024 字符', () => {
    const commands = buildSendKeysCommands('%1', new Uint8Array(32 * 1024).fill(0x78));
    expect(commands).toHaveLength((32 * 1024) / SEND_KEYS_HEX_CHUNK_BYTES);
    for (const argv of commands) {
      expect(argv.slice(4)).toHaveLength(SEND_KEYS_HEX_CHUNK_BYTES);
      expect(argv.join(' ').length).toBeLessThanOrEqual(1024);
    }
  });

  test('空输入不产生命令', () => {
    expect(buildSendKeysCommands('%1', new Uint8Array(0))).toEqual([]);
  });
});

describe('parseSendKeysHexArgv / buildSendKeysArgv', () => {
  test('round-trips send-keys -H argv and rejects non-matching commands', () => {
    const argv = buildSendKeysArgv('%3', ['1b', '5b', '41']);
    expect(parseSendKeysHexArgv(argv)).toEqual({ paneId: '%3', hex: ['1b', '5b', '41'] });
    expect(parseSendKeysHexArgv(['send-keys', '-l', '-t', '%1', '41'])).toBeNull();
    expect(parseSendKeysHexArgv(['send-keys', '-H', '-t'])).toBeNull();
    expect(parseSendKeysHexArgv(['send-keys', '-H', '-t', '%1', 'gg'])).toBeNull();
  });

  test('merged argv decodes to the exact concatenation of previously separate payloads', () => {
    const first = new TextEncoder().encode('\x1b[<35;21;2M');
    const second = new TextEncoder().encode('中');
    const left = parseSendKeysHexArgv(buildSendKeysCommands('%1', first)[0]);
    const right = parseSendKeysHexArgv(buildSendKeysCommands('%1', second)[0]);
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    const merged = buildSendKeysArgv('%1', left!.hex.concat(right!.hex));
    const hex = parseSendKeysHexArgv(merged)?.hex ?? [];
    const decoded = Uint8Array.from(hex, (token) => Number.parseInt(token, 16));
    expect(decoded).toEqual(Uint8Array.from([...first, ...second]));
  });
});
