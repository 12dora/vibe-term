import { SetupApiError } from '@tmex/api-client/local/setup-api';
import { errorMessage } from '@tmex/shared';
import { setupErrorKey } from './validation';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 本次设置连的是 Hub 还是中继：同一个错误码两边的文案不一样。 */
export type SetupUplinkKind = 'hub' | 'relay';

/**
 * 这些错误码的 `message` 才是真正的诊断信息，本地化文案只是它的抬头：
 * `join_failed` 会带上 `ca_fingerprint_mismatch` 之类的原因，`hub_unreachable` 带网络错误，
 * `env_write_failed` 带文件路径与 errno，`direct_*` 带下载 / 加载失败的原因。
 * 其余错误码（`weak_password`、`user_exists` 等）的 message 就是码本身，附上只会更吵。
 */
const DETAIL_BEARING_CODES = new Set([
  'join_failed',
  'hub_unreachable',
  'env_write_failed',
  'direct_unsupported',
  'direct_download_failed',
  'direct_failed',
  'relay_unreachable',
]);

/**
 * 这几个码的通用文案写的是 Hub，中继路径必须换一套：加入中继失败却显示「Hub 拒绝了本次
 * 加入请求」，用户会去查一台根本没参与的机器。
 */
const RELAY_SPECIFIC_CODES = new Set([
  'join_failed',
  'hub_unreachable',
  'node_revoked',
  'node_exists',
]);

/** 中继路径优先取专用键；没有专用文案的码回落到通用键。 */
export function setupErrorKeyFor(code: string, uplink: SetupUplinkKind): string | null {
  const base = setupErrorKey(code);
  if (!base) return null;
  if (uplink === 'relay' && RELAY_SPECIFIC_CODES.has(code)) {
    return `nodes.setup.errors.relay.${code}`;
  }
  return base;
}

/** 后端错误码优先走本地化文案；未知码退化成「未知错误 + 原始 message」。 */
export function describeSetupError(
  t: Translate,
  error: unknown,
  uplink: SetupUplinkKind = 'hub'
): string {
  if (error instanceof SetupApiError) {
    const key = setupErrorKeyFor(error.code, uplink);
    if (!key) return t('nodes.setup.errors.unknown', { message: error.message || error.code });
    const base = t(key);
    const detail = error.message.trim();
    if (DETAIL_BEARING_CODES.has(error.code) && detail && detail !== error.code) {
      return t('nodes.setup.errors.withDetail', { base, detail });
    }
    return base;
  }
  const message = errorMessage(error);
  return t('nodes.setup.errors.unknown', { message });
}
