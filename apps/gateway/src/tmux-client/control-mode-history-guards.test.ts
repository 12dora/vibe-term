import { describe, expect, test } from 'bun:test';
import { ControlModeCommandQueue } from './control-mode-capture';
import { captureControlHistory, historyRangeArgv } from './control-mode-history';
import { createControlModeParser } from './control-mode-parser';

const encoder = new TextEncoder();

function harness() {
  const queue = new ControlModeCommandQueue();
  const outputs: string[] = [];
  const parser = createControlModeParser({
    onOutput: (_pane, data) => outputs.push(new TextDecoder().decode(data)),
    onNotification: () => {},
    onExit: () => {},
    onBlockBegin: () => queue.nextBlockIsLiteral(),
    onBlockEnd: (block) => queue.handleBlock(block),
  });
  const capture = () =>
    captureControlHistory(queue, () => {}, historyRangeArgv('%1', -10, -1), 4096);
  return { queue, outputs, parser, capture };
}

describe('literal history block guards', () => {
  for (const kind of ['end', 'error']) {
    for (const fragmented of [false, true]) {
      test(`retains mismatched %${kind} history lines (${fragmented ? 'fragmented' : 'single chunk'})`, async () => {
        const h = harness();
        try {
          const capture = h.capture();
          const nextCapture = h.capture();
          const text = [
            'first',
            `%${kind} ordinary-history-text`,
            `%${kind} 1 9 1`,
            `%${kind} 2 7 1`,
            `%${kind} 1 7 0`,
            `%${kind}`,
            `%${kind} 1 7 1 extra`,
            'last',
          ].join('\n');
          const wire = encoder.encode(
            `%begin 1 7 1\n${text}\n%end 1 7 1\n%begin 1 8 1\nnext page\n%end 1 8 1\n%output %1 live\n`
          );
          if (fragmented) {
            for (const byte of wire) h.parser.push(new Uint8Array([byte]));
          } else {
            h.parser.push(wire);
          }
          const pages = await Promise.all([capture, nextCapture]);
          expect(pages).toEqual([`${text}\n`, 'next page\n']);
          expect(h.outputs).toEqual(['live']);
        } finally {
          h.queue.dispose();
        }
      });
    }
  }

  test('a matching error guard still rejects the capture and advances the queue', async () => {
    const h = harness();
    try {
      const capture = h.capture();
      const nextCapture = h.capture();
      h.parser.push(
        encoder.encode(
          '%begin 1 7 1\ncapture failed\n%error 1 7 1\n%begin 1 8 1\nnext page\n%end 1 8 1\n'
        )
      );
      await expect(capture).rejects.toThrow('capture failed');
      expect(await nextCapture).toBe('next page\n');
    } finally {
      h.queue.dispose();
    }
  });
});
