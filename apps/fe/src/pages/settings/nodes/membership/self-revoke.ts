// 退出 mesh 前对旧 hub 的「自吊销」：尽力而为，失败不挡退出。
//
// 与节点表里的吊销是同一条路径——`POST /api/auth/keylog?hub=sync` 送一条 `revoke-node`
// 记录，entry 先等 hub ack 再本地 append。区别只在目标是**本机自己**：本机马上就要
// 清空全部 mesh 状态，旧 hub 上留一条已吊销的记录比留一条看似在线的幽灵节点更干净。
//
// hub 不可达、用户取消凭据、记录被拒都只当作警告：本地退出照常进行，
// 旧 hub 上的那条记录由管理员在 hub 侧手动吊销。

import type { RecordSigner } from '@/auth/key-log-actions';
import { headFromResponse } from '@/auth/key-log-actions';
import { buildRevokeNodeRecord } from '@/node/enrollment';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { errorMessage } from '@tmex/shared';
import { encodeBase64url } from '@tmex/shared/auth';

export type SelfRevokeOutcome =
  | { kind: 'revoked' }
  /** 用户在凭据对话框里取消。 */
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: string };

export interface SelfRevokeInput {
  api: Pick<AuthApi, 'keyLogHead' | 'appendKeyLog'>;
  uid: string;
  rootEpoch: number;
  /** 本机 node id：32 位小写 hex。 */
  nodeIdHex: string;
  reason?: string;
  /** 作用域式取签名者（`CredentialPromptHandle.withSigner`）：签完即清零，不进复用窗口。 */
  withSigner: <T>(
    fn: (signer: RecordSigner) => Promise<T>,
    options?: { purpose?: 'revoke' }
  ) => Promise<T | null>;
}

export const SELF_REVOKE_REASON = 'leave-hub';

export async function selfRevokeNode(input: SelfRevokeInput): Promise<SelfRevokeOutcome> {
  try {
    const head = headFromResponse(await input.api.keyLogHead());
    const result = await input.withSigner(
      async (signer) => {
        const record = await buildRevokeNodeRecord({
          head,
          rootEpoch: input.rootEpoch,
          uid: input.uid,
          nodeIdHex: input.nodeIdHex,
          reason: input.reason ?? SELF_REVOKE_REASON,
          signer,
        });
        return input.api.appendKeyLog(
          { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) },
          { hubSync: true }
        );
      },
      { purpose: 'revoke' }
    );
    if (!result) return { kind: 'cancelled' };
    if (!result.ok) return { kind: 'failed', reason: result.code };
    // hub 没确认就等于没吊销：服务端一条都没落库（B2-6）。
    if (result.hubAck !== true) {
      return { kind: 'failed', reason: result.hubError || 'hub_unconfirmed' };
    }
    return { kind: 'revoked' };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && code) return { kind: 'failed', reason: code };
    return { kind: 'failed', reason: errorMessage(error) };
  }
}
