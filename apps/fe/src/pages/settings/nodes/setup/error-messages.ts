import { SetupApiError } from '@vibeterm/api-client/local/setup-api';
import { errorMessage } from '@vibeterm/shared';
import { setupErrorKey } from './validation';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 设置路径连的是中继。 */
export type SetupUplinkKind = 'relay';

/**
 * 这些错误码的 `message` 才是真正的诊断信息，本地化文案只是它的抬头：
 * `join_failed` 会带上 `ca_fingerprint_mismatch` 之类的原因，`relay_unreachable` 带网络错误，
 * `env_write_failed` 带文件路径与 errno，`direct_*` 带下载 / 加载失败的原因。
 * 其余错误码（`weak_password`、`user_exists` 等）的 message 就是码本身，附上只会更吵。
 */
const DETAIL_BEARING_CODES = new Set([
  'join_failed',
  'env_write_failed',
  'direct_unsupported',
  'direct_download_failed',
  'direct_failed',
  'relay_unreachable',
]);

/**
 * 这几个码的通用文案写的是旧 Hub 口径，中继路径必须换一套。
 */
const RELAY_SPECIFIC_CODES = new Set(['join_failed', 'node_revoked', 'node_exists']);

/** 中继路径优先取专用键；没有专用文案的码回落到通用键。 */
export function setupErrorKeyFor(code: string, _uplink: SetupUplinkKind): string | null {
  const mapped = code === 'hub_unreachable' ? 'relay_unreachable' : code;
  const base = setupErrorKey(mapped);
  if (!base) return null;
  if (RELAY_SPECIFIC_CODES.has(mapped)) {
    return `nodes.setup.errors.relay.${mapped}`;
  }
  return base;
}

/** 后端错误码优先走本地化文案；未知码退化成「未知错误 + 原始 message」。 */
export function describeSetupError(
  t: Translate,
  error: unknown,
  uplink: SetupUplinkKind = 'relay'
): string {
  if (error instanceof SetupApiError) {
    const mapped = error.code === 'hub_unreachable' ? 'relay_unreachable' : error.code;
    const key = setupErrorKeyFor(mapped, uplink);
    if (!key) return t('nodes.setup.errors.unknown', { message: error.message || error.code });
    const base = t(key);
    const detail = error.message.trim();
    if (DETAIL_BEARING_CODES.has(mapped) && detail && detail !== error.code && detail !== mapped) {
      return t('nodes.setup.errors.withDetail', { base, detail });
    }
    return base;
  }
  const message = errorMessage(error);
  return t('nodes.setup.errors.unknown', { message });
}
