export const EcKind = {
  HELLO: 0x01,
  READY: 0x02,
  STDIN: 0x10,
  STDIN_EOF: 0x11,
  RESIZE: 0x12,
  SIGNAL: 0x13,
  ACK: 0x14,
  CLOSE: 0x15,
  STDOUT: 0x20,
  STDERR: 0x21,
  EXIT: 0x22,
  STDIN_ACK: 0x23,
  ERROR: 0x24,
  PING: 0x30,
  PONG: 0x31,
} as const;

export type EcKindValue = (typeof EcKind)[keyof typeof EcKind];

export const EC_HEADER_BYTES = 5;
export const EC_CHUNK_BYTES = 64 * 1024;
export const EC_MAX_FRAME_PAYLOAD = 1024 * 1024;
export const EC_WINDOW_BYTES = 4 * 1024 * 1024;
export const EC_ACK_BYTES = 256 * 1024;
export const EC_ACK_DELAY_MS = 200;
export const EC_PING_MS = 15_000;
export const EC_DEAD_MS = 45_000;
export const EC_DEFAULT_DETACH_GRACE_MS = 300_000;
export const EC_MAX_DETACH_GRACE_MS = 3_600_000;
export const EC_MAX_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
export const EC_MAX_SESSIONS = 64;

export const EC_DEFAULT_TERM = 'xterm-256color';
export const EC_MAX_PTY_DIMENSION = 1000;

export const EC_SIGNALS = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGKILL',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
  'SIGWINCH',
] as const;

export const EC_ERROR_CODES = [
  'invalid_request',
  'protocol_error',
  'device_not_found',
  'exec_unsupported_device',
  'exec_spawn_failed',
  'pty_unsupported',
  'session_not_found',
  'resume_gap',
  'session_limit',
  'forbidden',
] as const;
