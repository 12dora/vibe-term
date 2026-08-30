import { PeerHandshakeError } from './types';

export type HandshakeTimeoutTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

export function withPeerHandshakeTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  timers: HandshakeTimeoutTimers = globalThis as HandshakeTimeoutTimers
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = timers.setTimeout(() => reject(new PeerHandshakeError('timeout', message)), ms);
    promise.then(
      (value) => {
        timers.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        timers.clearTimeout(timer);
        reject(err);
      }
    );
  });
}
