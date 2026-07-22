import type { ControlModeBlock } from './control-mode-parser';
import { isTmuxPaneId } from './snapshot-format';

export interface AtomicPaneCapture {
  text: string;
  cols: number;
  rows: number;
  cursorX: number | null;
  cursorY: number | null;
  alternateScreen: boolean;
  historySize: number;
}

interface PendingControlCommand<T = unknown> {
  literal: boolean;
  transform: (block: ControlModeBlock) => T;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ControlModeCommandQueue {
  private readonly pending: PendingControlCommand[] = [];
  private poisoned = false;

  constructor(private readonly onPoison?: () => void) {}

  execute<T>(
    write: (command: string) => void,
    command: string,
    options: {
      literal?: boolean;
      timeoutMs?: number;
      transform: (block: ControlModeBlock) => T;
    }
  ): Promise<T> {
    if (this.poisoned) return Promise.reject(new Error('tmux control command queue is closed'));
    return new Promise<T>((resolve, reject) => {
      const pending: PendingControlCommand<T> = {
        literal: options.literal ?? false,
        transform: options.transform,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.poison(new Error(`tmux control command timed out: ${command.slice(0, 80)}`));
        }, options.timeoutMs ?? 10_000),
      };
      this.pending.push(pending as PendingControlCommand);
      try {
        write(command.endsWith('\n') ? command : `${command}\n`);
      } catch (error) {
        this.poison(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  nextBlockIsLiteral(): boolean {
    return this.pending[0]?.literal ?? false;
  }

  handleBlock(block: ControlModeBlock): boolean {
    const pending = this.pending.shift();
    if (!pending) return false;
    clearTimeout(pending.timer);
    if (block.isError) {
      pending.reject(new Error(block.lines.join('\n') || 'tmux control command failed'));
      return true;
    }
    try {
      pending.resolve(pending.transform(block));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  dispose(reason = 'tmux control command queue closed'): void {
    if (this.poisoned) return;
    this.poisoned = true;
    const error = new Error(reason);
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private poison(error: Error): void {
    if (this.poisoned) return;
    this.poisoned = true;
    for (const pending of this.pending.splice(0)) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.onPoison?.();
  }
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parsePaneFrameInfo(block: ControlModeBlock): Omit<AtomicPaneCapture, 'text'> {
  const info = block.lines[0]?.split('|');
  const cols = parseNonNegativeInteger(info?.[0]);
  const rows = parseNonNegativeInteger(info?.[1]);
  if (cols === null || rows === null || cols < 1 || rows < 1) {
    throw new Error('invalid tmux pane frame info');
  }
  return {
    cols,
    rows,
    alternateScreen: info?.[2] === '1',
    cursorX: parseNonNegativeInteger(info?.[3]),
    cursorY: parseNonNegativeInteger(info?.[4]),
    historySize: parseNonNegativeInteger(info?.[5]) ?? 0,
  };
}

export async function capturePaneFrameAtControlBarrier(
  queue: ControlModeCommandQueue,
  write: (command: string) => void,
  paneId: string,
  historyLines: number,
  onBarrier: () => void,
  timeoutMs = 10_000
): Promise<AtomicPaneCapture> {
  if (!isTmuxPaneId(paneId)) throw new Error(`invalid tmux pane id: ${paneId}`);
  const boundedHistoryLines = Math.max(0, Math.min(4096, Math.floor(historyLines)));
  const infoPromise = queue.execute(write, `display-message -p -t ${paneId} "#{pane_width}|#{pane_height}|#{alternate_on}|#{cursor_x}|#{cursor_y}|#{history_size}"`, {
    timeoutMs,
    transform: parsePaneFrameInfo,
  });
  const captureArgs = [
    'capture-pane',
    '-p',
    '-e',
    '-J',
    '-N',
    '-t',
    paneId,
    ...(boundedHistoryLines > 0 ? ['-S', `-${boundedHistoryLines}`] : []),
  ];
  const textPromise = queue.execute(write, captureArgs.join(' '), {
    literal: true,
    timeoutMs,
    transform: (block) => {
      onBarrier();
      return block.lines.length > 0 ? `${block.lines.join('\n')}\n` : '';
    },
  });
  const [info, text] = await Promise.all([infoPromise, textPromise]);
  return { ...info, text };
}
