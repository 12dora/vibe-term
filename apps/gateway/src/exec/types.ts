export type ExecErrorCode =
  | 'exec_unsupported_device'
  | 'device_not_found'
  | 'exec_timeout'
  | 'exec_spawn_failed'
  | 'exec_output_limit'
  | 'invalid_body';

export type ExecRequest = {
  deviceId: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  timeoutMs: number;
  shell: boolean;
};

export type ExecStartEvent = {
  type: 'start';
  pid: number | null;
  device: { id: string; type: 'local' | 'ssh' };
};

export type ExecChunkEvent = { type: 'stdout' | 'stderr'; base64: string };

export type ExecExitEvent = {
  type: 'exit';
  code: number | null;
  signal: string | null;
  durationMs: number;
  truncated: { stdout: boolean; stderr: boolean };
};

export type ExecErrorEvent = { type: 'error'; code: ExecErrorCode; message: string };

export type ExecEvent = ExecStartEvent | ExecChunkEvent | ExecExitEvent | ExecErrorEvent;

export type ExecSink = {
  emit: (event: ExecEvent) => void;
  isOpen: () => boolean;
};
