// 传输有两段（leg）；toast 同时显示两条进度。
// 上传：leg1 浏览器→VibeTerm，leg2 VibeTerm→服务器；下载：leg1 服务器→VibeTerm，leg2 VibeTerm→浏览器。

export interface LegProgress {
  /** 0-100 */
  pct: number;
  /** 速度文本（如 1.23 MB/s） */
  rate?: string;
  /** 字节明细（如 1.2 MB / 64 MB） */
  detail?: string;
  /** 本段已完成字节数（精确值，供合并总进度用） */
  bytes?: number;
  /** 本段总字节数（已知时） */
  totalBytes?: number;
}

export type OnLeg = (leg: 1 | 2, p: LegProgress) => void;

export interface TransferOpts {
  onLeg?: OnLeg;
  /**
   * 两段在合并进度条里的相对权重，调用前默认 [1, 1]。
   * 上传：init 返回后给 [1, init.commitProgress === false ? 0 : 1]；
   * 下载：prepare 结束时给 [prepare 是否有过增量进度 ? 1 : 0, 1]。
   */
  onLegWeights?: (weights: readonly [number, number]) => void;
  signal?: AbortSignal;
  /**
   * 浏览器段的并行流数（上传的并行 PUT / 下载的并行 Range GET）。默认直连 4；
   * 经中继时调用方压到 2——中继按流计配额，开太多会挤掉同租户的其他传输。
   */
  streams?: number;
}

/** 直连（或同机）默认 4 条并行流。 */
export const DIRECT_TRANSFER_STREAMS = 4;
/** 经中继：中继按流计配额，压到 2 条，避免挤掉同租户的其他传输。 */
export const RELAY_TRANSFER_STREAMS = 2;

export function pickTransferStreams(viaRelay: boolean): number {
  return viaRelay ? RELAY_TRANSFER_STREAMS : DIRECT_TRANSFER_STREAMS;
}
