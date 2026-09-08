import { describe, expect, test } from 'bun:test';
import type { TmuxConnectionOptions } from './connection-types';
import { ControlModeCommandQueue } from './control-mode-capture';
import { createControlModeParser } from './control-mode-parser';
import { InputCommandWindow } from './input-command-window';
import { LocalExternalTmuxConnection } from './local-external-connection';
import { PaneInputPacer } from './pane-input-pacer';
import { TestClock } from './pane-input-test-helpers';
import { SshExternalTmuxConnection } from './ssh-external-connection';

const encode = (text: string) => new TextEncoder().encode(text);
const mouse = '\x1b[<64;1;1M';

function harness(kind: 'local' | 'ssh', ackDelay?: number) {
  const clock = new TestClock();
  const queue = new ControlModeCommandQueue();
  const window = new InputCommandWindow(() => 4);
  const writes: Array<{ pane: string; text: string; at: number }> = [];
  const errors: Error[] = [];
  const options: TmuxConnectionOptions = {
    deviceId: 'input-r3',
    onEvent: () => {},
    onTerminalOutput: () => {},
    onTerminalHistory: () => {},
    onSnapshot: () => {},
    onError: (error) => errors.push(error),
    onClose: () => {},
  };
  const connection =
    kind === 'local'
      ? new LocalExternalTmuxConnection(options, { getDevice: () => null })
      : new SshExternalTmuxConnection(options, { getDevice: () => null });
  const pacer = new PaneInputPacer(
    (pane, bytes, ...completion) => connection.sendInputBytes(pane, bytes, ...completion),
    clock,
    () => {},
    (error) => errors.push(error as Error)
  );
  const parser = createControlModeParser({
    onOutput: (pane, bytes) => pacer.onOutput(pane, bytes),
    onBlockEnd: (block) => queue.handleBlock(block),
    onNotification: () => {},
    onExit: () => {},
  });
  let nextReply = 0;
  const ack = () => {
    const id = ++nextReply;
    parser.push(encode(`%begin 1 ${id} 1\n%end 1 ${id} 1\n`));
  };
  const control = {
    write: (command: string) => {
      const argv = command.trim().split(' ');
      writes.push({
        pane: argv[3],
        text: Buffer.from(argv.slice(4).join(''), 'hex').toString(),
        at: clock.now(),
      });
      if (ackDelay !== undefined) clock.setTimeout(ack, ackDelay);
    },
  };
  Object.assign(connection, {
    connected: true,
    controlCommands: queue,
    ...(kind === 'local'
      ? { controlProcess: control, inputCommands: window }
      : { controlChannel: control }),
  });
  return {
    clock,
    writes,
    errors,
    ack,
    pacer,
    send: (text: string, pane = '%1') => pacer.sendInputBytes(pane, encode(text)),
    output: (text = 'redraw', pane = '%1') => parser.push(encode(`%output ${pane} ${text}\n`)),
    dispose: () => {
      pacer.dispose();
      window.dispose('test complete');
      queue.dispose();
    },
  };
}

async function flush() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('R3 input submission and ordering', () => {
  test.each([1000, 1002, 1003])(
    'reporting reset %i cancels an active mouse waiting behind a four-slot paste',
    async (mode) => {
      const h = harness('local');
      try {
        const paste = h.send('A'.repeat(1024));
        const wheel = h.send(mouse, '%2');
        const otherWheel = h.send(mouse, '%3');
        const key = h.send('key', '%2');
        expect(h.writes).toHaveLength(4);
        h.output(`\x1b[?${mode}l`, '%2');
        await wheel;
        expect(h.writes).toHaveLength(4);
        for (let index = 0; index < 4; index += 1) h.ack();
        await flush();
        expect(h.writes.slice(4)).toEqual([
          { pane: '%3', text: mouse, at: 0 },
          { pane: '%2', text: 'key', at: 0 },
        ]);
        h.ack();
        h.ack();
        await Promise.all([paste, otherWheel, key]);
        expect(h.errors).toEqual([]);
      } finally {
        h.dispose();
      }
    }
  );

  test.each(['local', 'ssh'] as const)(
    '%s submits ten ordinary keys at their typing times despite 200 ms acknowledgments',
    async (kind) => {
      const h = harness(kind, 200);
      try {
        const completions: Promise<void>[] = [];
        for (let index = 0; index < 10; index += 1) {
          completions.push(h.send(String(index)));
          expect(h.writes.at(-1)).toEqual({ pane: '%1', text: String(index), at: index * 100 });
          h.clock.tick(100);
          await flush();
        }
        h.clock.tick(100);
        await Promise.all(completions);
        expect(h.writes.map((write) => write.at)).toEqual(
          Array.from({ length: 10 }, (_, index) => index * 100)
        );
        expect(h.errors).toEqual([]);
      } finally {
        h.dispose();
      }
    }
  );

  test.each(['local', 'ssh'] as const)(
    '%s keeps mouse barriers but submits the next mouse before the intervening key acknowledgment',
    async (kind) => {
      const h = harness(kind);
      try {
        const completions = [h.send(mouse), h.send('a'), h.send('b'), h.send(mouse), h.send('c')];
        expect(h.writes.map((write) => write.text)).toEqual([mouse]);
        h.clock.tick(10);
        h.ack();
        h.output();
        expect(h.writes.map((write) => write.text)).toEqual([mouse, 'a', 'b']);
        await flush();
        h.clock.tick(7);
        expect(h.writes).toHaveLength(3);
        h.clock.tick(1);
        expect(h.writes.map((write) => write.at)).toEqual([0, 10, 10, 18]);
        h.ack();
        h.ack();
        expect(h.writes).toHaveLength(4);
        h.ack();
        expect(h.writes.map((write) => write.text)).toEqual([mouse, 'a', 'b', mouse, 'c']);
        h.ack();
        await Promise.all(completions);
        expect(h.errors).toEqual([]);
      } finally {
        h.dispose();
      }
    }
  );

  test('a mouse cannot overtake ordinary chunks still waiting in the transport window', async () => {
    const h = harness('local');
    try {
      const completions = [h.send('A'.repeat(1536)), h.send(mouse), h.send('key')];
      expect(h.writes).toHaveLength(4);
      for (let index = 0; index < 4; index += 1) h.ack();
      await flush();
      expect(h.writes.map((write) => write.text)).toEqual([
        ...Array.from({ length: 6 }, () => 'A'.repeat(256)),
        mouse,
      ]);
      h.ack();
      h.ack();
      expect(h.writes).toHaveLength(7);
      h.ack();
      expect(h.writes.at(-1)?.text).toBe('key');
      h.ack();
      await Promise.all(completions);
    } finally {
      h.dispose();
    }
  });
});
