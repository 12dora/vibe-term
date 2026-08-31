// 设置页三块「受保护状态」查询的键与取数函数：面板里的 hook 与标签悬停预取共用同一份。
//
// 为什么不直接从各自的 hook 文件里 import：`use-tunnel-status` / `use-tls-status` 还挂着
// tunnel-model、tls-form 这类只有面板才用得上的模块，预取一 import 就把它们从各自的 lazy
// chunk 搬回设置页 chunk，正好抵消掉按标签分块的收益。这里只依赖 `@tmex/api-client` 的薄封装。
//
// 三个接口问的都是**浏览器直连的那台机器**（隧道 / TLS / 本机运行态都只能在本机配置），
// 所以固定用 api-client 的默认实例，与 hook 保持一致——换成调用方传进来的 node 级 client
// 会往同一个查询键里写进另一台机器的状态。

import { defaultLocalApi } from '@tmex/api-client/local/local-api';
import { defaultTlsApi } from '@tmex/api-client/local/tls-api';
import type { TlsStatusResponse } from '@tmex/api-client/local/tls-types';
import { fetchTunnelStatus } from '@tmex/api-client/local/tunnel-api';
import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import type { TunnelStatusResponse } from '@tmex/shared';

export const TUNNEL_STATUS_QUERY_KEY = ['tunnel-status'] as const;
export const LOCAL_STATUS_QUERY_KEY = ['local-status'] as const;
export const TLS_STATUS_QUERY_KEY = ['tls-status'] as const;

export function fetchSelfTunnelStatus(): Promise<TunnelStatusResponse> {
  return fetchTunnelStatus();
}

export function fetchSelfLocalStatus(): Promise<LocalStatusResponse> {
  return defaultLocalApi.status();
}

export function fetchSelfTlsStatus(): Promise<TlsStatusResponse> {
  return defaultTlsApi.status();
}
