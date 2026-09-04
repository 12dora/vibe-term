export const RELAY_LINK_ERROR_CODES = [
  'connect-failed',
  'connect-timeout',
  'auth-timeout',
  'auth-rejected',
  'heartbeat-lost',
  'kicked',
  'dns',
  'refused',
  'tls',
  'protocol',
  'unknown',
] as const;

export type RelayLinkErrorCode = (typeof RELAY_LINK_ERROR_CODES)[number];

const NULL_REASONS = /^(stopped|aborted)$/i;

/** 先匹配更具体的原因，再落到宽泛类（timeout / protocol）。 */
const RULES: Array<[RegExp, RelayLinkErrorCode]> = [
  [/\bmember-/, 'auth-rejected'],
  [
    /(?:^|[\s:_-])(?:kicked|tenant-kicked|revoked|password_rotated|relay-kicked|relay-revoked|relay-password_rotated|relay-tenant-gone)(?:$|[\s:_-])/,
    'kicked',
  ],
  [/\b(?:missed-pong|ping-failed|heartbeat[-_]timeout|heartbeat[-_]lost)\b/, 'heartbeat-lost'],
  [/\bauth-timeout\b/, 'auth-timeout'],
  [
    /\b(?:connect-timeout|etimedout|timed out)\b|(?:^|[\s:_-])timeout(?:$|[\s:_-])/,
    'connect-timeout',
  ],
  [/\bconnect-failed\b/, 'connect-failed'],
  [
    /\b(?:auth_rejected|bad-token|token-epoch|unauthorized|unauthenticated|bad-sig|bad-nonce|bad-cert|unknown-tenant)\b/,
    'auth-rejected',
  ],
  [
    /\b(?:econnrefused|econnreset|connection refused|connect refused)\b|(?:^|[\s:_-])refused(?:$|[\s:_-])/,
    'refused',
  ],
  [
    /\b(?:enotfound|eai_again|getaddrinfo|name not resolved|nodename nor servname)\b|(?:^|[\s:_-])dns(?:$|[\s:_-])/,
    'dns',
  ],
  [
    /\b(?:tls|ssl|cert_|err_tls|err_cert)\b|certificate|self[- ]signed|unable to verify|hostname mismatch|altname/,
    'tls',
  ],
  [
    /\b(?:protocol(?:[_-]error)?|proto-unsupported|client-too-old|ws-closed|link-closed|invalid frame|bad upgrade|relay-replaced|relay-stop)\b/,
    'protocol',
  ],
];

export function classifyRelayLinkError(raw: string | null | undefined): RelayLinkErrorCode | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (!text) return null;
  if (NULL_REASONS.test(text)) return null;
  const blob = text.toLowerCase();
  for (const [re, code] of RULES) {
    if (re.test(blob)) return code;
  }
  return 'unknown';
}
