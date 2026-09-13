import type { LinkSession } from '@vibeterm/shared/link';
import type { UplinkState } from './types';

export function waitUntilUplinkClosed(input: {
  signal: AbortSignal;
  state: () => UplinkState;
  link: () => LinkSession | null;
  onStateChange: (cb: (state: UplinkState) => void) => () => void;
}): Promise<void> {
  if (isWaitReleased(input)) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let off: (() => void) | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', finish);
      off?.();
      resolve();
    };
    off = input.onStateChange((state) => {
      if (state !== 'online') finish();
    });
    input.signal.addEventListener('abort', finish, { once: true });
    void input.link()?.closed.then(finish, finish);
    if (isWaitReleased(input)) finish();
  });
}

function isWaitReleased(input: {
  signal: AbortSignal;
  state: () => UplinkState;
  link: () => LinkSession | null;
}): boolean {
  return input.signal.aborted || input.state() !== 'online' || input.link() == null;
}
