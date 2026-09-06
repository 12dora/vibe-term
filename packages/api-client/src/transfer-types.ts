// 传输有两段（leg）；toast 同时显示两条进度。
// 上传：leg1 浏览器→VibeTerm，leg2 VibeTerm→服务器；下载：leg1 服务器→VibeTerm，leg2 VibeTerm→浏览器。

export interface LegProgress {
  /** 0-100 */
  pct: number;
  /** 速度文本（如 1.23 MB/s） */
  rate?: string;
  /** 字节明细（如 1.2 MB / 64 MB） */
  detail?: string;
}

export type OnLeg = (leg: 1 | 2, p: LegProgress) => void;

export interface TransferOpts {
  onLeg?: OnLeg;
  signal?: AbortSignal;
  /**
   * leg1 的并行流数（上传的并行 PUT）。默认直连 4；经中继时调用方压到 2——
   * 中继按流计配额，开太多会挤掉同租户的其他传输。
   */
  streams?: number;
}

/** 直连（或同机）默认 4 条并行流。 */
export const DIRECT_UPLOAD_STREAMS = 4;
/** 经中继：中继按流计配额，压到 2 条，避免挤掉同租户的其他传输。 */
export const RELAY_UPLOAD_STREAMS = 2;

export function pickUploadStreams(viaRelay: boolean): number {
  return viaRelay ? RELAY_UPLOAD_STREAMS : DIRECT_UPLOAD_STREAMS;
}
