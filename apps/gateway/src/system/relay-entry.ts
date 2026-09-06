// 中继入口地址（`<中继>/n/<本机 nodeId>`）给「接入设备」面板用。
// 与分享候选同一条链路（同一个 `RelayEntryProbe`），但不吃 `relayShareAccessUrl` 的 5 s 记忆化：
// 面板要的是「探测刚回来就能看到」，记忆化会把首次的 null 又压 5 s。

import { RelayEntryProbe } from '../share/relay-entry-probe';
import { buildShareOriginContext, defaultShareOriginSources } from '../share/share-origins';

/** 探通的中继入口；未探通、或不是中继上联时为 null。调用本身会把探测发出去。 */
export function relayEntryAccessUrl(): string | null {
  const context = buildShareOriginContext(defaultShareOriginSources, null);
  return context.candidates.find((item) => item.kind === 'relay')?.accessUrl ?? null;
}

/** 等在途的中继入口探测全部落地；没有在途探测时立即返回。 */
export async function awaitRelayEntryProbe(): Promise<void> {
  const probe = defaultShareOriginSources.relayProbe();
  if (!(probe instanceof RelayEntryProbe)) return;
  await probe.settle();
}
