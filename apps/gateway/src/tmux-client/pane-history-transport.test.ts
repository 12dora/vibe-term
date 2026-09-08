import { describe, expect, test } from 'bun:test';
import { truncateUtf8Tail } from '../bytes';
import { createControlModeParser } from './control-mode-parser';
import { LocalExternalTmuxConnection } from './local-external-connection';
import { PaneHistoryReader } from './pane-history-reader';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const epoch = new Uint8Array(16).fill(1);

function createTransport(control: boolean, initialRows: string[]) {
  let rows = initialRows;
  let sequence = 0;
  const spawns: string[][] = [];
  const writes: string[] = [];
  function stdout(argv: string[], maxOutputBytes?: number) {
    if (argv.includes('display-message')) return `${rows.length}|1\n`;
    const start = Number(argv[argv.indexOf('-S') + 1]);
    const end = Number(argv[argv.indexOf('-E') + 1]);
    const text = `${rows.slice(rows.length + start, rows.length + end + 1).join('\n')}\n`;
    return maxOutputBytes === undefined
      ? text
      : decoder.decode(truncateUtf8Tail(encoder.encode(text), maxOutputBytes));
  }
  class TestConnection extends LocalExternalTmuxConnection {
    constructor() {
      super(
        {
          deviceId: 'history-test',
          onEvent: () => {},
          onTerminalOutput: () => {},
          onTerminalHistory: () => {},
          onSnapshot: () => {},
          onError: () => {},
          onClose: () => {},
        },
        {
          getDevice: () => null,
          run: async (argv, limit) => {
            spawns.push(argv);
            return { exitCode: 0, stdout: stdout(argv, limit), stderr: '' };
          },
        }
      );
      this.connected = true;
    }
    protected override getControlWriter() {
      return control
        ? (command: string) => {
            writes.push(command);
            const argv = Array.from(
              command.matchAll(/"([^"\n]*)"/g),
              (match) => match[1] as string
            );
            const body = stdout(argv);
            const id = ++sequence;
            queueMicrotask(() =>
              parser.push(encoder.encode(`%begin 1 ${id} 1\n${body}%end 1 ${id} 1\n`))
            );
          }
        : null;
    }
    makeParser() {
      return createControlModeParser({
        onOutput: () => {},
        onNotification: () => {},
        onExit: () => {},
        onBlockBegin: () => this.controlCommands.nextBlockIsLiteral(),
        onBlockEnd: (block) => this.controlCommands.handleBlock(block),
      });
    }
    disposeQueue() {
      this.controlCommands.dispose();
    }
  }
  const connection = new TestConnection();
  const parser = connection.makeParser();
  const reader = new PaneHistoryReader(connection, {
    createEpoch: () => new Uint8Array(16).fill(2),
  });
  return {
    connection,
    reader,
    spawns,
    writes,
    replace: (next: string[]) => {
      rows = next;
    },
  };
}

describe('history transport parity', () => {
  for (const limit of [1, 8, 32, 128, 256 * 1024]) {
    test(`returns byte-identical pages and cursors with byte limit ${limit}`, async () => {
      const rows = [
        'old',
        '\x1b[31m红色\x1b[0m  ',
        '',
        '%output literal \\033 \\134',
        '🙂'.repeat(40),
        '',
      ];
      const spawn = createTransport(false, rows);
      const control = createTransport(true, rows);
      let cursor = null;
      do {
        const a = await spawn.reader.readPage('%1', epoch, cursor, limit);
        const b = await control.reader.readPage('%1', epoch, cursor, limit);
        expect(b).toEqual(a);
        expect(b.data.byteLength).toBeLessThanOrEqual(limit);
        cursor = a.nextCursor;
      } while (cursor);
      expect(control.spawns).toHaveLength(0);
      expect(control.writes.length / 3).toBe(spawn.spawns.length / 2);
      spawn.connection.disposeQueue();
      control.connection.disposeQueue();
    });
  }

  test('preserves byte-identical oversized capture tails', async () => {
    const rows = ['🙂'.repeat(20_000)];
    const spawn = createTransport(false, rows);
    const control = createTransport(true, rows);
    const a = await spawn.reader.readPage('%1', epoch, null, 8);
    const b = await control.reader.readPage('%1', epoch, null, 8);
    expect(b).toEqual(a);
    expect(b.truncated).toBe(true);
    expect(b.data.byteLength).toBeLessThanOrEqual(8);
    spawn.connection.disposeQueue();
    control.connection.disposeQueue();
  });

  for (const control of [false, true]) {
    test(`preserves eviction detection with control=${control}`, async () => {
      const h = createTransport(control, ['zero', 'one', 'two', 'three']);
      const first = await h.reader.readPage('%1', epoch, null, 32);
      h.replace(['one', 'two', 'three', 'four']);
      await expect(h.reader.readPage('%1', epoch, first.nextCursor, 32)).rejects.toMatchObject({
        reason: 'cache_evicted',
      });
      h.connection.disposeQueue();
    });

    test(`returns an empty page with control=${control}`, async () => {
      const h = createTransport(control, []);
      const page = await h.reader.readPage('%1', epoch, null, 32);
      expect(page.data).toHaveLength(0);
      expect(page.nextCursor).toBeNull();
      expect(h.writes.length + h.spawns.length).toBe(1);
      h.connection.disposeQueue();
    });
  }
});
