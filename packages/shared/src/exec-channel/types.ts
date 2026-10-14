import type { EC_ERROR_CODES, EC_SIGNALS } from './constants';

export type ExecSignal = (typeof EC_SIGNALS)[number];
export type ExecChannelErrorCode = (typeof EC_ERROR_CODES)[number];

export type ExecCommand =
  | { kind: 'shell'; script: string; sh?: boolean }
  | { kind: 'argv'; argv: string[] }
  | { kind: 'login' }
  | { kind: 'subsystem'; name: 'sftp' };

export type ExecPtySpec = { cols: number; rows: number; term?: string };

export type ExecOpenSpec = {
  device?: string;
  command: ExecCommand;
  cwd?: string;
  env?: Record<string, string>;
  pty?: ExecPtySpec | null;
  stdin: boolean;
  timeoutMs?: number;
  detachGraceMs?: number;
};

export type ResolvedExecOpenSpec = {
  device?: string;
  command: ExecCommand;
  cwd?: string;
  env: Record<string, string>;
  pty: { cols: number; rows: number; term: string } | null;
  stdin: boolean;
  timeoutMs: number;
  detachGraceMs: number;
};

export type ExecHello =
  | { v: 1; op: 'open'; spec: ExecOpenSpec }
  | { v: 1; op: 'resume'; sessionId: string; out: number };

export type ValidatedExecHello =
  | { v: 1; op: 'open'; spec: ResolvedExecOpenSpec }
  | { v: 1; op: 'resume'; sessionId: string; out: number };

export type ExecDeviceInfo = { id: string; name: string; type: 'local' | 'ssh' };

export type ExecReady = {
  sessionId: string;
  resumed: boolean;
  pid: number | null;
  device: ExecDeviceInfo;
  pty: boolean;
  stdin: number;
  stdinClosed: boolean;
  out: number;
  window: { stdin: number; out: number };
};

export type ExecExit = {
  code: number | null;
  signal: string | null;
  reason: 'exit' | 'timeout' | 'killed';
  durationMs: number;
};

export type ExecResizePayload = { cols: number; rows: number };
export type ExecSignalPayload = { signal: ExecSignal };
export type ExecAckPayload = { out: number };
export type ExecClosePayload = { kill: boolean };
export type ExecStdinAckPayload = { stdin: number };
export type ExecErrorPayload = { code: ExecChannelErrorCode; message: string };

export type EcFrame = { kind: number; payload: Uint8Array };

export type ValidateOpenSpecResult =
  | { ok: true; spec: ResolvedExecOpenSpec }
  | { ok: false; message: string };
export type ValidateHelloResult =
  | { ok: true; hello: ValidatedExecHello }
  | { ok: false; message: string };
