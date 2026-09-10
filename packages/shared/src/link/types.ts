export const FRAME_HEADER_SIZE = 10;
export const MAX_FRAME_PAYLOAD = 1024 * 1024;
/** Sender-side DATA payload cap. Receivers still accept frames up to MAX_FRAME_PAYLOAD. */
export const MAX_DATA_SEND_PAYLOAD = 256 * 1024;
export const INITIAL_STREAM_WINDOW = 1024 * 1024;
/**
 * 优先写（PONG / DEVICE_LATENCY 等控制帧）保留的发送信用：普通写永远不占用窗口的这一段。
 * 纯发送侧策略——线格式与接收侧窗口记账都不变，与旧版本互通。
 */
export const PRIORITY_SEND_RESERVE = 16 * 1024;
// Cover 64 default relay streams plus the control stream at a full window each.
export const MAX_LINK_UNACKED = 65 * INITIAL_STREAM_WINDOW;
export const CTL_STREAM_ID = 0;
export const FLAG_HEAD = 1 << 0;
export const GCM_TAG_LENGTH = 16;
export const AES_GCM_IV_LENGTH = 12;
export const SC_KEY_LENGTH = 32;
export const SC_DIRECTION_INITIATOR = 1;
export const SC_DIRECTION_ACCEPTOR = 2;
/** Refuse further SecureChannel sends once the per-direction counter reaches 2^63. */
export const SC_REKEY_COUNTER = 2n ** 63n;

export const FrameOp = {
  OPEN: 1,
  DATA: 2,
  END: 3,
  RST: 4,
  WINDOW: 5,
} as const;

export type FrameOp = (typeof FrameOp)[keyof typeof FrameOp];

export type LinkRole = 'initiator' | 'acceptor';

export type StreamCloseReason = 'end' | 'rst' | 'link-closed';

export type StreamCloseInfo = {
  reason: StreamCloseReason;
  message?: string;
};

export type LinkCloseInfo = {
  reason: string;
};

export type StreamChunk = {
  bytes: Uint8Array;
  head: boolean;
};

export type WriteOptions = {
  head?: boolean;
  /**
   * 控制面优先写：排在已排队但尚未开始的普通写之前，并可动用 `PRIORITY_SEND_RESERVE`
   * 预留信用。只能插在消息与消息之间，不会挤进一条多片消息的分片中间。
   */
  priority?: boolean;
};

export interface LinkStream {
  readonly id: number;
  readonly openPayload: Uint8Array;
  /**
   * Incoming DATA as a pull-based ReadableStream.
   * WINDOW credits are sent when the consumer pulls a chunk (highWaterMark = 0),
   * so the sender's 1 MiB window does not reopen until the application reads.
   */
  readonly readable: ReadableStream<StreamChunk>;
  /** Resolves once the bytes are accepted into the send window. Rejects on RST / link close. */
  write(bytes: Uint8Array, opts?: WriteOptions): Promise<void>;
  /** Half-close our send direction after previously queued writes. New writes reject immediately. */
  end(): Promise<void>;
  reset(reason?: string): void;
  readonly closed: Promise<StreamCloseInfo>;
  /** Fired once on peer RST or link close (not on a clean bilateral END). */
  onAbort(cb: () => void): void;
  /** 已计入发送窗口、对端尚未回信用的字节数（发送侧在途）。 */
  readonly outstandingBytes?: number;
  /** 对端回窗口信用时触发，即发送侧在途下降。 */
  onSendWindowCredit?(cb: () => void): void;
  /**
   * 给优先写预留 `PRIORITY_SEND_RESERVE` 的发送信用（普通写不再占用这一段）。
   * 只有需要控制面低延迟的流（ws 转发）才调用，且必须在开始写之前调用。
   */
  reservePriorityCredit?(): void;
}

export type LinkCtl = {
  send(bytes: Uint8Array): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
};

export interface LinkSession {
  openStream(openPayload: Uint8Array): Promise<LinkStream>;
  onStream(cb: (stream: LinkStream) => void): void;
  readonly ctl: LinkCtl;
  readonly lastFrameAt?: number;
  close(reason?: string): void;
  readonly closed: Promise<LinkCloseInfo>;
}

export type ByteTransport = {
  send(bytes: Uint8Array): void | Promise<void>;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (reason?: string) => void): void;
  close(reason?: string): void;
};

export type Frame = {
  streamId: number;
  op: number;
  flags: number;
  payload: Uint8Array;
};

export type FrameHeader = {
  streamId: number;
  op: number;
  flags: number;
  length: number;
};

export class LinkError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LinkError';
    this.code = code;
  }
}

export function isFrameOp(op: number): op is FrameOp {
  return (
    op === FrameOp.OPEN ||
    op === FrameOp.DATA ||
    op === FrameOp.END ||
    op === FrameOp.RST ||
    op === FrameOp.WINDOW
  );
}
