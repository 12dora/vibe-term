import type { ServerSocketAdapter, WebSocketTransportInput } from '@tmex/shared/link';
import { UPLINK_CTL_TYPES } from './uplink-protocol';

function stripCtlControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) out += ch;
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const UPLINK_CONNECT_RULES: Array<[RegExp, string]> = [
  [/\b(enotfound|eai_again|getaddrinfo|dns)\b|name not resolved|nodename nor servname/, 'dns'],
  [/\b(econnrefused|econnreset)\b|connection refused|connect refused/, 'refused'],
  [/connect-timeout|auth-timeout|\b(etimedout|timeout|timed out)\b/, 'timeout'],
  [
    /\b(tls|ssl|cert_|err_tls|err_cert)\b|certificate|self signed|self-signed|unable to verify|hostname mismatch|altname/,
    'tls',
  ],
  [
    /\b(unauthorized|unauthenticated|unknown-cert|revoked|bad-cert|bad-sig|bad-nonce|auth_rejected)\b|auth reject|auth failed/,
    'auth_rejected',
  ],
  [/protocol|ws-closed|link-closed|invalid frame|bad upgrade/, 'protocol'],
  [/aborted/, 'aborted'],
];

export function classifyUplinkConnectError(err: unknown): string {
  const closeCode = readCloseCode(err);
  if (closeCode === 1015) return 'tls';
  if (
    closeCode != null &&
    ((closeCode >= 4400 && closeCode <= 4499) || (closeCode >= 400 && closeCode <= 599))
  ) {
    return `http_${closeCode}`;
  }
  const blob = `${readNodeErrorCode(err)} ${stripCtlControlChars(errMsg(err))}`.toLowerCase();
  for (const [re, code] of UPLINK_CONNECT_RULES) {
    if (re.test(blob)) return code;
    if (code === 'tls') {
      const http =
        blob.match(/\bhttp[_\s-]+([1-5]\d{2})\b/) ??
        blob.match(/\b(4401|4403|401|403|404|502|503)\b/);
      if (http?.[1]) return `http_${http[1]}`;
    }
  }
  return 'unknown';
}

function readCloseCode(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const closeCode = (err as { closeCode?: unknown }).closeCode;
  if (typeof closeCode === 'number' && Number.isFinite(closeCode)) return closeCode;
  const message = err instanceof Error ? err.message : '';
  const match = message.match(/\bws-closed (\d+)/);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function readNodeErrorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

export function sanitizeUplinkReason(value: string): string {
  const trimmed = stripCtlControlChars(value).slice(0, 64);
  if (trimmed && /^[a-zA-Z0-9_.:-]+$/.test(trimmed)) return trimmed;
  return classifyUplinkConnectError(new Error(trimmed));
}

export function sanitizeUplinkCtlType(type: string): string {
  return (UPLINK_CTL_TYPES as readonly string[]).includes(type) ? type : 'unknown';
}

export function envPositiveMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function mapUplinkCtlError(kind: 'decode' | 'handler', err: unknown): string {
  const message = stripCtlControlChars(errMsg(err));
  if (message.startsWith('unknown uplink ctl')) return 'unknown_type';
  if (message === 'ctl too large') return 'ctl_too_large';
  if (message === 'ctl too deep') return 'ctl_too_deep';
  if (message === 'ctl string too long' || message === 'ctl array too long') return 'ctl_too_long';
  if (message.startsWith('ctl field')) return 'invalid_field';
  if (message.startsWith('ctl ')) return 'invalid_ctl';
  return kind === 'decode' ? 'decode_error' : 'handler_error';
}

export function ctlTypeHint(bytes: Uint8Array): string {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const t =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as { t?: unknown }).t
        : undefined;
    if (typeof t === 'string') return t;
  } catch {
    /* ignore */
  }
  return '';
}

function isServerSocketAdapter(value: WebSocketTransportInput): value is ServerSocketAdapter {
  return (
    typeof (value as ServerSocketAdapter).onDrain === 'function' &&
    typeof (value as ServerSocketAdapter).onMessage === 'function'
  );
}

export function closeTransport(ws: WebSocketTransportInput): void {
  try {
    if (isServerSocketAdapter(ws)) ws.close(1000, 'connect-timeout');
    else (ws as WebSocket).close(1000, 'connect-timeout');
  } catch {
    /* ignore */
  }
}
