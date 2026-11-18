// 吊销类动作（移除节点 / 批量移除 / 卸载）的凭据框选项。
//
// 已加入中继时，吊销之后必须换中继令牌，enroll proof 只有账户密码（根钥）能签：
// 这种情况下一开始就只收密码，一次确认做完吊销 + 换令牌，不会在节点删掉之后再弹第二个框。

import type { WithSignerOptions } from '@/auth/credential-prompt';
import { getMeshRelayState, isRelayMode } from '@/node/mesh-relay';

/**
 * 同步读本页已有的中继状态快照（宿主级 store，30 秒兜底轮询 + 节点事件补拉），不额外发请求。
 * 快照陈旧的两种误差都安全：误判「已加入」只是多问一次密码；误判「未加入」时
 * 换令牌会得到 `RELAY_REKEY_NEEDS_ROOT`，走「持久错误 + 重试（仅密码）」。
 */
export function revokeSignerOptions(): WithSignerOptions {
  const snapshot = getMeshRelayState();
  const joined = isRelayMode(snapshot) && snapshot.relays.length > 0;
  return joined ? { purpose: 'revoke', passwordOnly: true } : { purpose: 'revoke' };
}
