import type { PromptMarker } from '../../tmux-client/pane-stream-parser';
import type { RunCommandEmulator, RunCommandMode, RunCommandShell } from './run-command';
import { posixExitCodeExpr } from './run-command-args';
import type { ByteOutputBuffer } from './run-command-buffer';

export interface RunCommandRuntime {
  sleepMs: (ms: number) => Promise<void>;
  now: () => number;
  makeNonce: () => string;
}

export function resolveRunCommandRuntime(deps: {
  sleepMs?: (ms: number) => Promise<void>;
  makeNonce?: () => string;
  now?: () => number;
}): RunCommandRuntime {
  const now = deps.now ?? (() => performance.now());
  let nonceCounter = 0;
  return {
    sleepMs: deps.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now,
    makeNonce: deps.makeNonce ?? (() => `n${++nonceCounter}${(now() | 0).toString(36)}`),
  };
}

export function buildRunCommandPayload(input: {
  command: string;
  usePosix: boolean;
  shell: RunCommandShell | undefined;
  nonce: string;
}): string {
  if (!input.usePosix) {
    return `${input.command}\r`;
  }
  const expr = posixExitCodeExpr(input.shell) ?? '$?';
  const marker = `printf '\\033]133;D;%s;tmex=${input.nonce}\\033\\\\' "${expr}"`;
  return `${input.command}; ${marker}\r`;
}

export function isMatchingExitMarker(marker: PromptMarker, nonce: string): boolean {
  return marker.kind === 'D' && (!nonce || marker.params.includes(`tmex=${nonce}`));
}

export function attachRunCommandTap(
  emulator: RunCommandEmulator,
  buffer: ByteOutputBuffer,
  getNonce: () => string
): { getReceivedMarker: () => PromptMarker | null; untap: () => void } {
  let receivedMarker: PromptMarker | null = null;
  const untap = emulator.tap({
    onBytes: (data) => buffer.append(data),
    onMarker: (marker) => {
      if (isMatchingExitMarker(marker, getNonce())) {
        receivedMarker = marker;
      }
    },
  });
  return {
    getReceivedMarker: () => receivedMarker,
    untap,
  };
}

export async function applyDisablePaging(input: {
  mode: RunCommandMode;
  disablePagingCommand: string | undefined;
  sendInput: (data: string) => void;
  sleepMs: (ms: number) => Promise<void>;
  resetBuffer: () => void;
}): Promise<void> {
  if (input.mode !== 'cli' || !input.disablePagingCommand) return;
  input.sendInput(`${input.disablePagingCommand}\r`);
  await input.sleepMs(200);
  input.resetBuffer();
}
