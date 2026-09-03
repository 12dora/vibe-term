export type WaitableSocket = {
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: { once?: boolean }
  ): void;
};

function stripControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) out += ch;
  }
  return out;
}

export function socketCloseError(ev: Event | { code?: number; reason?: string }): Error {
  const rec = ev as { code?: number; reason?: string };
  const code = typeof rec.code === 'number' ? rec.code : 0;
  const reason = typeof rec.reason === 'string' ? stripControlChars(rec.reason) : '';
  const err = new Error(reason ? `ws-closed ${code} ${reason}` : `ws-closed ${code}`);
  (err as Error & { closeCode: number }).closeCode = code;
  return err;
}

export function socketErrorEvent(ev: Event | { error?: unknown; message?: string }): Error {
  const rec = ev as { error?: unknown; message?: string };
  if (rec.error instanceof Error) return rec.error;
  if (typeof rec.message === 'string' && rec.message) {
    return new Error(stripControlChars(rec.message));
  }
  return new Error('ws-error');
}

function isServerSocketAdapter(value: object): boolean {
  return (
    typeof (value as { onDrain?: unknown }).onDrain === 'function' &&
    typeof (value as { onMessage?: unknown }).onMessage === 'function'
  );
}

function quietClose(socket: WaitableSocket, reason: string): void {
  try {
    socket.close(1000, reason);
  } catch {
    /* ignore */
  }
}

export function waitSocketOpen(
  ws: object,
  timeoutMs: number,
  signal?: AbortSignal,
  abortCloseReason = 'aborted'
): Promise<void> {
  if (isServerSocketAdapter(ws)) return Promise.resolve();
  const socket = ws as WaitableSocket;
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const abortSock = (reason: string, err: Error) => {
      finish(err);
      quietClose(socket, reason);
    };
    const onAbort = () => {
      const err = signal?.reason instanceof Error ? signal.reason : new Error('aborted');
      abortSock(abortCloseReason, err);
    };
    const timer = setTimeout(
      () => abortSock('connect-timeout', new Error('connect-timeout')),
      timeoutMs
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.addEventListener('open', () => finish(), { once: true });
    socket.addEventListener('close', (ev) => finish(socketCloseError(ev)), { once: true });
    socket.addEventListener('error', (ev) => finish(socketErrorEvent(ev)), { once: true });
  });
}
