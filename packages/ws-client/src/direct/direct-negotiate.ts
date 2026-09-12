import type { DirectApiClientLike, RtcConfigResponse } from './rtc-types';

export const RTC_CONFIG_PATH = '/api/mesh/rtc-config';

/** `GET /api/mesh/rtc-config`：ICE 配置拿不到时仍尝试建连（同内网 host 候选不需要 STUN）。 */
export async function fetchRtcConfig(
  apiClient: DirectApiClientLike,
  signal?: AbortSignal
): Promise<RtcConfigResponse | null> {
  try {
    const res = await apiClient.fetch(RTC_CONFIG_PATH, signal ? { signal } : {});
    if (!res.ok) return null;
    return (await res.json()) as RtcConfigResponse;
  } catch {
    return null;
  }
}
