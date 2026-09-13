// GitHub Release 资产的速度探测契约：先解析 302 到最终 CDN 地址，再用一小段 Range 读判定
// 「快 / 慢 / 不可达」。投递策略（节点自拉 vs 入口推包）与并行下载都依赖这一份判定，
// 实现放在同文件（WPU1 补全），调用方只依赖本签名。

export type ReleaseSpeedVerdict = 'fast' | 'slow' | 'unreachable';

export interface ReleaseSpeedProbeOptions {
  /** 整次探测的墙钟上限（默认 3000 ms）。 */
  deadlineMs?: number;
  /** 期限内至少要收到的字节数才算 `fast`（默认 64 KiB）。 */
  minBytes?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ReleaseSpeedProbeResult {
  verdict: ReleaseSpeedVerdict;
  /** 302 跟随后的最终资产地址；不可达时为 null。 */
  finalUrl: string | null;
  /** 期限内收到的字节数。 */
  bytes: number;
  elapsedMs: number;
  /** 最终地址是否接受 `Range`（206）。并行下载据此决定单流还是多流。 */
  acceptsRanges: boolean;
  /** `Content-Length`（若已知）。 */
  totalBytes: number | null;
  error?: string;
}

export async function probeReleaseAssetSpeed(
  _url: string,
  _opts: ReleaseSpeedProbeOptions = {}
): Promise<ReleaseSpeedProbeResult> {
  throw new Error('probeReleaseAssetSpeed: not implemented (WPU1)');
}
