// 传输有两段（leg）；toast 同时显示两条进度。
// 上传：leg1 浏览器→tmex，leg2 tmex→服务器；下载：leg1 服务器→tmex，leg2 tmex→浏览器。

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
}
