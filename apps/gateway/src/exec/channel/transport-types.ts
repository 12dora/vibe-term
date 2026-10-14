export interface ExecTransport {
  send(frame: Uint8Array): void;
  readonly bufferedBytes: number;
  onDrain(cb: () => void): void;
  close(code: number, reason: string): void;
}

/** 以节点会话鉴权的 exec 通道所依附的会话；令牌鉴权与免登录部署没有。 */
export type ExecSessionRef = { sid: string; viaNodeId: string };

export type ExecChannelAuth = {
  uid: string | null;
  tokenId: string | null;
  session?: ExecSessionRef | null;
};

export interface ExecChannelInbound {
  onBytes(chunk: Uint8Array): void;
  onClose(): void;
}
