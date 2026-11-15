import type { ControlModeCommandQueue } from './control-mode-capture';
import { type InputCommandWindow, isQueueFullError } from './input-command-window';
import { PIPELINED_INPUT_TIMEOUT_MS, buildSendKeysCommands } from './input-encoder';
import type { InputSubmission } from './input-submission';

interface ExternalInputTransport {
  queue: ControlModeCommandQueue;
  write?: (value: string) => void;
  window?: InputCommandWindow;
  isCurrent: () => boolean;
  run: (argv: string[]) => Promise<unknown>;
  onError: (error: Error) => void;
  timeoutMs?: number | (() => number);
}

function resolveInputTimeoutMs(
  timeoutMs: number | (() => number) | undefined,
  commandCount: number
): number | undefined {
  const resolved = typeof timeoutMs === 'function' ? timeoutMs() : timeoutMs;
  if (commandCount <= 1) return resolved;
  return Math.max(resolved ?? 0, PIPELINED_INPUT_TIMEOUT_MS);
}

export function sendExternalInput(
  transport: ExternalInputTransport,
  paneId: string,
  data: Uint8Array,
  onAck?: () => void,
  submission?: InputSubmission
): Promise<void> {
  const commands = buildSendKeysCommands(paneId, data);
  let remaining = commands.length;
  const acknowledge = () => {
    remaining -= 1;
    if (remaining === 0 && transport.isCurrent()) onAck?.();
  };
  const execute = (argv: string[], commandAck?: () => void): Promise<unknown> => {
    if (!transport.isCurrent()) return Promise.reject(new Error('tmux input transport changed'));
    if (submission && !submission.isValid()) return Promise.resolve();
    if (submission) submission.submitted = true;
    const timeoutMs = resolveInputTimeoutMs(transport.timeoutMs, commands.length);
    const ack = commandAck ?? acknowledge;
    if (!transport.write) return transport.run(argv).then(ack);
    return transport.queue.execute(transport.write, argv.join(' '), {
      transform: () => undefined,
      onAck: ack,
      sample: true,
      poisonOnTimeout: false,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  };
  const completion = transport.window
    ? transport.window.enqueue(commands, execute, submission, acknowledge)
    : Promise.all(commands.map((argv) => execute(argv, acknowledge))).then(() => undefined);
  void completion.catch((error) => {
    if (!isQueueFullError(error)) transport.onError(error);
  });
  return completion;
}
