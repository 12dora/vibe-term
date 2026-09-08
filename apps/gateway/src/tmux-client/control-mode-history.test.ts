import { describe, expect, test } from 'bun:test';
import { ControlModeCommandQueue } from './control-mode-capture';
import { captureAtBarrier, captureControlHistory, historyRangeArgv } from './control-mode-history';
import { createControlModeParser } from './control-mode-parser';
import { buildHistoryRangeRequest } from './pane-history-page';
import { PaneHistoryCursorError } from './pane-history-session';
import { TmuxTargetMissingError } from './target-missing';

const encoder = new TextEncoder();
const info = { historySize: 5, cols: 1 };
const range = buildHistoryRangeRequest({
  ...info,
  beforeLine: 5,
  byteLimit: 32,
  maxPageBytes: 256 * 1024,
  hasAnchor: false,
});

function harness() {
  const queue = new ControlModeCommandQueue();
  const writes: string[] = [];
  const outputs: string[] = [];
  const parser = createControlModeParser({
    onOutput: (_pane, data) => outputs.push(new TextDecoder().decode(data)),
    onNotification: () => {},
    onExit: () => {},
    onBlockBegin: () => queue.nextBlockIsLiteral(),
    onBlockEnd: (block) => queue.handleBlock(block),
  });
  return {
    queue,
    writes,
    outputs,
    parser,
    write: (command: string) => {
      writes.push(command);
    },
  };
}

function reply(id: number, text: string, error = false) {
  return `%begin 1 ${id} 1\n${text}\n%${error ? 'error' : 'end'} 1 ${id} 1\n`;
}

describe('control history capture', () => {
  test('queues the barrier pair and later input without waiting for replies', async () => {
    const h = harness();
    const capture = captureAtBarrier(h.queue, h.write, '%1', range, info);
    expect(h.writes).toHaveLength(2);
    const input = h.queue.execute(h.write, 'send-keys -H -t %1 61', { transform: () => {} });
    expect(h.writes).toHaveLength(3);
    expect(h.writes[0]).toContain('display-message');
    expect(h.writes[1]).toContain('capture-pane');
    const text = '\x1b[31m红色\x1b[0m  \n\n%output literal \\033 \\134';
    const wire = `${reply(1, '5|1') + reply(2, text) + reply(3, '')}%output %1 \\033[32mlive\\033[0m\n`;
    for (const byte of encoder.encode(wire)) h.parser.push(new Uint8Array([byte]));
    expect(await capture).toBe(`${text}\n`);
    await input;
    expect(h.outputs).toEqual(['\x1b[32mlive\x1b[0m']);
    h.queue.dispose();
  });

  for (const changed of ['6|1', '5|2']) {
    test(`rejects changed barrier metadata ${changed}`, async () => {
      const h = harness();
      const capture = captureAtBarrier(h.queue, h.write, '%1', range, info);
      h.parser.push(encoder.encode(reply(1, changed) + reply(2, 'three\nfour')));
      await expect(capture).rejects.toMatchObject({ reason: 'cache_evicted' });
      h.queue.dispose();
    });
  }

  test('preserves trailing blank rows and bounds the UTF-8 tail', async () => {
    const h = harness();
    const capture = captureControlHistory(h.queue, h.write, historyRangeArgv('%1', -2, -1), 6);
    h.parser.push(encoder.encode(reply(1, 'prefix中🙂\n')));
    expect(await capture).toBe('🙂\n\n');
    h.queue.dispose();
  });

  test('maps missing targets and drains the other reply without poisoning input', async () => {
    const h = harness();
    const capture = captureAtBarrier(h.queue, h.write, '%1', range, info);
    h.parser.push(encoder.encode(reply(1, "can't find pane: %1", true) + reply(2, 'ignored')));
    await expect(capture).rejects.toBeInstanceOf(TmuxTargetMissingError);
    const input = h.queue.execute(h.write, 'send-keys -H -t %2 61', { transform: () => 'ok' });
    h.parser.push(encoder.encode(reply(3, '')));
    expect(await input).toBe('ok');
    h.queue.dispose();
  });

  test('rejects malformed metadata and invalid ranges', async () => {
    const h = harness();
    const capture = captureAtBarrier(h.queue, h.write, '%1', range, info);
    h.parser.push(encoder.encode(reply(1, 'bad') + reply(2, 'ignored')));
    await expect(capture).rejects.toThrow('invalid tmux pane history info');
    expect(() => historyRangeArgv('%1\nsend-keys', -2, -1)).toThrow();
    expect(() => historyRangeArgv('%1', 1.5, -1)).toThrow();
    h.queue.dispose();
  });

  test('disconnect rejects outstanding captures', async () => {
    const h = harness();
    const capture = captureAtBarrier(h.queue, h.write, '%1', range, info);
    h.queue.dispose('disconnected');
    await expect(capture).rejects.toThrow('disconnected');
  });
});
