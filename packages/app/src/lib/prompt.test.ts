import { afterEach, describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { createPromptSession, promptConfirm, promptInternals, promptText } from './prompt';

const realStdinIsTty = promptInternals.stdinIsTty;
const realOpen = promptInternals.openControllingTerminal;

afterEach(() => {
  promptInternals.stdinIsTty = realStdinIsTty;
  promptInternals.openControllingTerminal = realOpen;
});

function fakeTty(line?: string): PassThrough & { isTTY?: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean };
  stream.isTTY = true;
  if (line !== undefined) {
    stream.write(line);
  }
  return stream;
}

describe('createPromptSession', () => {
  test('uses process.stdin and never opens /dev/tty when stdin is not a TTY', () => {
    let opened = 0;
    promptInternals.stdinIsTty = () => false;
    promptInternals.openControllingTerminal = () => {
      opened += 1;
      return fakeTty();
    };

    const session = createPromptSession();
    expect(session.input).toBe(process.stdin);
    expect(opened).toBe(0);
    session.release();
  });

  test('falls back to process.stdin when /dev/tty cannot be opened', () => {
    promptInternals.stdinIsTty = () => true;
    promptInternals.openControllingTerminal = () => {
      throw new Error('ENXIO: no such device or address');
    };

    const session = createPromptSession();
    expect(session.input).toBe(process.stdin);
    expect(() => session.release()).not.toThrow();
  });

  test('opens the controlling terminal when stdin is a TTY and destroys it once', () => {
    const stream = fakeTty();
    let destroyed = 0;
    stream.destroy = () => {
      destroyed += 1;
      return stream;
    };
    promptInternals.stdinIsTty = () => true;
    promptInternals.openControllingTerminal = () => stream;

    const session = createPromptSession();
    expect(session.input).toBe(stream);
    session.release();
    session.release();
    expect(destroyed).toBe(1);
  });

  test('opens one handle per prompt and releases it, so no fd is left behind', async () => {
    const streams: Array<PassThrough & { isTTY?: boolean }> = [];
    promptInternals.stdinIsTty = () => true;
    promptInternals.openControllingTerminal = () => {
      const stream = fakeTty('answer\n');
      streams.push(stream);
      return stream;
    };

    await promptText({ nonInteractive: false }, 'one');
    await promptText({ nonInteractive: false }, 'two');

    expect(streams.length).toBe(2);
    for (const stream of streams) {
      expect(stream.destroyed).toBe(true);
    }
  });
});

describe('promptText / promptConfirm over the controlling terminal', () => {
  test('reads the typed answer', async () => {
    promptInternals.stdinIsTty = () => true;
    promptInternals.openControllingTerminal = () => fakeTty('/opt/vibeterm\n');

    const answer = await promptText({ nonInteractive: false }, 'Install directory', '/tmp/x');
    expect(answer).toBe('/opt/vibeterm');
  });

  test('an empty line keeps the default', async () => {
    promptInternals.stdinIsTty = () => true;
    promptInternals.openControllingTerminal = () => fakeTty('\n');

    const answer = await promptText({ nonInteractive: false }, 'Install directory', '/tmp/x');
    expect(answer).toBe('/tmp/x');
  });

  test('confirm reads y/n and falls back to the default on an empty line', async () => {
    promptInternals.stdinIsTty = () => true;
    promptInternals.openControllingTerminal = () => fakeTty('n\n');
    expect(await promptConfirm({ nonInteractive: false }, 'Autostart?', true)).toBe(false);

    promptInternals.openControllingTerminal = () => fakeTty('\n');
    expect(await promptConfirm({ nonInteractive: false }, 'Autostart?', true)).toBe(true);
  });

  test('non-interactive context never touches the terminal', async () => {
    let opened = 0;
    promptInternals.stdinIsTty = () => true;
    promptInternals.openControllingTerminal = () => {
      opened += 1;
      return fakeTty();
    };

    expect(await promptText({ nonInteractive: true }, 'Install directory', '/tmp/x')).toBe(
      '/tmp/x'
    );
    expect(await promptConfirm({ nonInteractive: true }, 'Autostart?', true)).toBe(true);
    expect(opened).toBe(0);
  });
});
