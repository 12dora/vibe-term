export function relayUplinkConnectReason(err: unknown): string {
  const msg = err instanceof Error ? err.message.trim() : '';
  if (!msg) return 'connect-failed';
  if (msg === 'aborted' || (msg.length <= 64 && /^[a-z0-9_.:-]+$/i.test(msg))) return msg;
  return 'connect-failed';
}
