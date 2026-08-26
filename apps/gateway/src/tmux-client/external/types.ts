export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExternalControlHandle {
  write: (data: string) => void;
}
