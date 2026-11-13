import type { ChildProcess } from 'node:child_process';

export function waitForSpawnAndDetach(child: ChildProcess, onSettled?: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      onSettled?.();
      fn();
    };
    child.once('error', (err) => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    });
    child.once('spawn', () => {
      finish(() => {
        child.unref();
        resolve();
      });
    });
  });
}
