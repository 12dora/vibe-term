import type { ControlModeCommandQueue } from './control-mode-capture';
import type { InputCommandWindow } from './input-command-window';
import { PIPELINED_INPUT_TIMEOUT_MS, buildSendKeysCommands } from './input-encoder';
import type { InputSubmission } from './input-submission';

interface ExternalInputTransport {
  queue: ControlModeCommandQueue;
  write?: (value: string) => void;
  window?: InputCommandWindow;
  isCurrent: () => boolean;
  run: (argv: string[]) => Promise<unknown>;
  onError: (error: Error) => void;
  timeoutMs?: number;
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
  const timeoutMs =
    transport.timeoutMs ?? (commands.length > 1 ? PIPELINED_INPUT_TIMEOUT_MS : undefined);
  const execute = (argv: string[]): Promise<unknown> => {
    if (!transport.isCurrent()) return Promise.reject(new Error('tmux input transport changed'));
    if (submission && !submission.isValid()) return Promise.resolve();
    if (submission) submission.submitted = true;
    if (!transport.write) return transport.run(argv).then(acknowledge);
    return transport.queue.execute(transport.write, argv.join(' '), {
      transform: () => undefined,
      onAck: acknowledge,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  };
  const completion = transport.window
    ? transport.window.enqueue(commands, execute, submission)
    : Promise.all(commands.map(execute)).then(() => undefined);
  void completion.catch((error) => transport.onError(error));
  return completion;
}
