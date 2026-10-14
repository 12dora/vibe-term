export interface ExecTransport {
  send(frame: Uint8Array): void;
  readonly bufferedBytes: number;
  onDrain(cb: () => void): void;
  close(code: number, reason: string): void;
}

export type ExecChannelAuth = { uid: string | null; tokenId: string | null };

export interface ExecChannelInbound {
  onBytes(chunk: Uint8Array): void;
  onClose(): void;
}
