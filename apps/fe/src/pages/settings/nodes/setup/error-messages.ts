import { SetupApiError } from '@tmex/api-client/local/setup-api';
import { setupErrorKey } from './validation';

type Translate = (key: string, options?: Record<string, unknown>) => string;

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
]);

/** 后端错误码优先走本地化文案；未知码退化成「未知错误 + 原始 message」。 */
export function describeSetupError(t: Translate, error: unknown): string {
  if (error instanceof SetupApiError) {
    const key = setupErrorKey(error.code);
    if (!key) return t('nodes.setup.errors.unknown', { message: error.message || error.code });
    const base = t(key);
    const detail = error.message.trim();
    if (DETAIL_BEARING_CODES.has(error.code) && detail && detail !== error.code) {
      return t('nodes.setup.errors.withDetail', { base, detail });
    }
    return base;
  }
  const message = error instanceof Error ? error.message : String(error);
  return t('nodes.setup.errors.unknown', { message });
}
