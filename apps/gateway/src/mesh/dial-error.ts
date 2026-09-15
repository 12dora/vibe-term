import { classifyUplinkConnectError } from './uplink-reconnect';

const DNS_FAIL_RE =
  /\b(enotfound|dns_enotfound|eai_noname|eai_again|eai_fail|getaddrinfo|failedtoopensocket)\b|failed to connect|was there a typo in the url|name not resolved|nodename nor servname|unable to connect\. is the computer able to access the url/;

const CONNECT_CODE_RE = /^(econnrefused|connectionrefused|ehostunreach|enetunreach|etimedout)$/;

export function isDnsClassFailure(err: unknown): boolean {
  if (classifyUplinkConnectError(err) === 'dns') return true;
  return DNS_FAIL_RE.test(`${errorCode(err)} ${errorMessage(err)}`.toLowerCase());
}

/** TCP 连不上：超时 / 拒连 / 不可达。TLS 握手失败、Expected 101 不算。 */
export function isConnectClassFailure(err: unknown): boolean {
  if (hasTimeoutErrorName(err)) return true;
  const blob = errorBlob(err);
  if (blob.includes('connect-timeout')) return true;
  if (CONNECT_CODE_RE.test(errorCode(err).toLowerCase())) return true;
  if (/\b(ehostunreach|enetunreach|etimedout)\b/.test(blob)) return true;
  if (/\beconnreset\b/.test(blob)) return false;
  return /\beconnrefused\b|connection refused|connect refused|\bfailed to connect\b/.test(blob);
}

export function isHardNonFallback(err: unknown): boolean {
  const classified = classifyUplinkConnectError(err);
  if (classified === 'auth_rejected' || classified === 'protocol') return true;
  if (classified.startsWith('http_')) return true;
  return classified === 'aborted' && !isConnectClassFailure(err);
}

export function connectFailureReason(err: unknown): string {
  const code = errorCode(err).trim().toLowerCase();
  if (code) return code;
  const blob = errorBlob(err);
  if (blob.includes('connect-timeout')) return 'connect-timeout';
  if (/\behostunreach\b/.test(blob)) return 'ehostunreach';
  if (/\benetunreach\b/.test(blob)) return 'enetunreach';
  if (/\beconnrefused\b|connection refused/.test(blob)) return 'econnrefused';
  return 'connect-failed';
}

function hasTimeoutErrorName(err: unknown): boolean {
  if (errorName(err) === 'TimeoutError') return true;
  if (!err || typeof err !== 'object') return false;
  const rec = err as { cause?: unknown; reason?: unknown };
  return errorName(rec.cause) === 'TimeoutError' || errorName(rec.reason) === 'TimeoutError';
}

function errorName(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function errorCode(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorBlob(err: unknown): string {
  const parts = [errorCode(err), errorMessage(err)];
  if (!err || typeof err !== 'object') return parts.join(' ').toLowerCase();
  const rec = err as { cause?: unknown; reason?: unknown };
  if (rec.cause) parts.push(errorCode(rec.cause), errorMessage(rec.cause));
  if (rec.reason) parts.push(errorCode(rec.reason), errorMessage(rec.reason));
  return parts.join(' ').toLowerCase();
}
