import type { ExecSignal } from '@vibeterm/shared/exec-channel';

export type ExecProcessExit = { code: number | null; signal: string | null };

export interface ExecProcess {
  readonly pid: number | null;
  readonly pty: boolean;
  readStdout(): Promise<Uint8Array | null>;
  readStderr(): Promise<Uint8Array | null>;
  writeStdin(bytes: Uint8Array): Promise<void>;
  endStdin(): Promise<void>;
  resize(cols: number, rows: number): void;
  signal(sig: ExecSignal): void;
  kill(): void;
  readonly exited: Promise<ExecProcessExit>;
}
