import { describe, expect, spyOn, test } from 'bun:test';
import { ControlModeCommandQueue } from './control-mode-capture';
import { createControlModeParser } from './control-mode-parser';
import { InputCommandWindow } from './input-command-window';

const encoder = new TextEncoder();

function harness(timeoutMs = 10_000, failAt = -1) {
  const window = new InputCommandWindow(() => 4);
  let poisonCount = 0;
  const queue = new ControlModeCommandQueue(() => {
    poisonCount += 1;
    window.dispose('poisoned');
  });
  const writes: string[] = [];
  const outputs: string[] = [];
  const transformed: string[] = [];
  const write = (command: string) => {
    if (writes.length === failAt) throw new Error('stdin failed');
    writes.push(command.trim());
  };
  const parser = createControlModeParser({
    onOutput: (_pane, bytes) => outputs.push(new TextDecoder().decode(bytes)),
    onNotification: () => {},
    onExit: () => {},
    onBlockBegin: () => queue.nextBlockIsLiteral(),
    onBlockEnd: (block) => queue.handleBlock(block),
  });
  return {
    window,
    queue,
    write,
    writes,
    outputs,
    transformed,
    poisonCount: () => poisonCount,
    push: (text: string) => parser.push(encoder.encode(text)),
    enqueue: (commands: string[]) =>
      window.enqueue(
        commands.map((command) => [command]),
        (argv) =>
          queue.execute(write, argv[0], {
            timeoutMs,
            transform: (block) => transformed.push(`${argv[0]}:${block.lines.join('|')}`),
          })
      ),
  };
}

function reply(id: number, text = '', error = false) {
  return `%begin 1 ${id} 1\n${text ? `${text}\n` : ''}%${error ? 'error' : 'end'} 1 ${id} 1\n`;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('input window with the real control queue and parser', () => {
  test('matches input, capture transforms and errors positionally around output notifications', async () => {
    const h = harness();
    const first = h.enqueue(['a', 'b']);
    const capture = h.queue.execute(h.write, 'capture-pane', {
      literal: true,
      transform: (block) => block.lines.join('\n'),
    });
    const failedCapture = h.queue.execute(h.write, 'capture-missing-pane', {
      literal: true,
      transform: () => 'unexpected',
    });
    const later = h.enqueue(['c', 'd', 'e', 'f']);
    expect(h.writes).toEqual(['a', 'b', 'capture-pane', 'capture-missing-pane', 'c', 'd']);
    h.push(`%output %1 before\n${reply(1, 'A')}`);
    await flush();
    expect(h.writes.at(-1)).toBe('e');
    h.push(reply(2, 'B'));
    await first;
    expect(h.writes.at(-1)).toBe('f');
    const literal = '%output %1 literal \\033\n%begin literal history\nlast';
    h.push(reply(3, literal) + reply(4, 'missing history', true));
    expect(await capture).toBe(literal);
    await expect(failedCapture).rejects.toThrow('missing history');
    h.push(`%output %1 after\n${reply(5, 'C') + reply(6, 'D') + reply(7, 'E') + reply(8, 'F')}`);
    await later;
    expect(h.transformed).toEqual(['a:A', 'b:B', 'c:C', 'd:D', 'e:E', 'f:F']);
    expect(h.outputs).toEqual(['before', 'after']);
    expect(h.poisonCount()).toBe(0);
    h.queue.dispose();
  });

  test('a normal error frees one slot without closing the queue or rejecting later payloads', async () => {
    const h = harness();
    const failed = h.enqueue(['a']);
    const later = h.enqueue(['b', 'c', 'd', 'e', 'f']);
    h.push(reply(1, 'no pane', true));
    await expect(failed).rejects.toThrow('no pane');
    expect(h.writes).toEqual(['a', 'b', 'c', 'd', 'e']);
    h.push(reply(2));
    await flush();
    h.push(reply(3) + reply(4) + reply(5) + reply(6));
    await later;
    expect(h.window.disposed).toBe(false);
    expect(h.poisonCount()).toBe(0);
    h.queue.dispose();
  });

  test('timeout poisons all four active commands and cancels pending input and timers', async () => {
    const h = harness(5);
    const cleared = spyOn(globalThis, 'clearTimeout');
    try {
      const inputs = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => h.enqueue([key]));
      const results = await Promise.allSettled(inputs);
      expect(results.map((result) => result.status)).toEqual(Array(6).fill('rejected'));
      expect(cleared).toHaveBeenCalledTimes(4);
      expect(h.poisonCount()).toBe(1);
      expect(h.writes).toEqual(['a', 'b', 'c', 'd']);
      h.push(reply(1) + reply(2) + reply(3) + reply(4));
      await expect(h.enqueue(['new'])).rejects.toThrow('poisoned');
      expect(h.writes).toEqual(['a', 'b', 'c', 'd']);
    } finally {
      cleared.mockRestore();
      h.queue.dispose();
    }
  });

  test('synchronous write failure closes the window before the pump can write more commands', async () => {
    const h = harness(10_000, 2);
    const cleared = spyOn(globalThis, 'clearTimeout');
    try {
      const paste = h.enqueue(['a', 'b', 'c', 'd', 'e', 'f']);
      await expect(paste).rejects.toThrow();
      expect(h.poisonCount()).toBe(1);
      expect(cleared).toHaveBeenCalledTimes(3);
      expect(h.writes).toEqual(['a', 'b']);
      await expect(h.enqueue(['new'])).rejects.toThrow('poisoned');
      h.push(reply(1) + reply(2));
      await flush();
      expect(h.writes).toEqual(['a', 'b']);
    } finally {
      cleared.mockRestore();
      h.queue.dispose();
    }
  });
});
