import { releaseTarballUrl } from '@vibeterm/shared';
import {
  type ReleaseSpeedProbeResult,
  probeReleaseAssetSpeed,
} from '../../../../packages/shared/src/release/speed-probe';

export type ReleaseSpeedGateResult =
  | { ok: true; probe: ReleaseSpeedProbeResult }
  | {
      ok: false;
      code: 'RELEASE_SLOW' | 'RELEASE_UNREACHABLE';
      verdict: 'slow' | 'unreachable';
      elapsedMs: number;
      bytes: number;
    };

export type ReleaseSpeedProbeFn = (
  url: string,
  opts?: Parameters<typeof probeReleaseAssetSpeed>[1]
) => Promise<ReleaseSpeedProbeResult>;

/** 启动前探测发行资产；慢 / 不可达时不改变升级状态。探测抛错按不可达处理。 */
export async function evaluateReleaseSpeedGate(
  version: string,
  probe: ReleaseSpeedProbeFn = probeReleaseAssetSpeed
): Promise<ReleaseSpeedGateResult> {
  let result: ReleaseSpeedProbeResult;
  try {
    result = await probe(releaseTarballUrl(version));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = {
      verdict: 'unreachable',
      finalUrl: null,
      bytes: 0,
      elapsedMs: 0,
      acceptsRanges: false,
      totalBytes: null,
      error: message,
    };
  }
  console.info(
    `[upgrade] release-speed-probe version=${version} verdict=${result.verdict} bytes=${result.bytes} elapsedMs=${result.elapsedMs}`
  );
  if (result.verdict === 'fast') return { ok: true, probe: result };
  const verdict: 'slow' | 'unreachable' = result.verdict === 'slow' ? 'slow' : 'unreachable';
  return {
    ok: false,
    code: verdict === 'slow' ? 'RELEASE_SLOW' : 'RELEASE_UNREACHABLE',
    verdict,
    elapsedMs: result.elapsedMs,
    bytes: result.bytes,
  };
}
