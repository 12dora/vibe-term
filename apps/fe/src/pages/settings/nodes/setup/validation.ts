// 「启用 hub」向导的纯校验与默认值推导。
//
// 规则与 `docs/2026082900-hub-ui-tls` 批次 1 契约（POST /api/setup/hub|join）逐条对齐：
// 前端先拦一遍只是为了少一次往返，后端仍是权威。

import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import { normalizeRelayUrl } from '@tmex/shared/relay';

export type NodeEnv = LocalStatusResponse['nodeEnv'];

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/**
 * join 串两种形态（见 `sub/api-contract-batch2.md`「Join-token v2」）：
 * v1 `<128 位 base64url>`；v2 追加 `.<64 位小写十六进制>`——自签 hub 的 CA SPKI 指纹，
 * 加入方靠它固定信任锚点。少一位多一位都不能放行，否则错误只会推迟到后端。
 */
const JOIN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{128}(?:\.[0-9a-f]{64})?$/;
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 64;

const ERROR_PREFIX = 'nodes.setup.errors.';

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

export type UrlVerdict = 'ok' | 'invalid' | 'insecure';

/**
 * `https:` 永远可用；`http://127.0.0.1|localhost` 只在非 production 下可用，返回 `insecure`
 * 让调用方决定是提示「需要 HTTPS」还是「需要勾上本地不安全连接」。
 */
export function classifyHubUrl(raw: string, nodeEnv: NodeEnv): UrlVerdict {
  const trimmed = raw.trim();
  if (!trimmed) return 'invalid';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'invalid';
  }
  if (url.protocol === 'https:') return 'ok';
  if (url.protocol !== 'http:') return 'invalid';
  if (nodeEnv === 'production') return 'invalid';
  return isLocalHostname(url.hostname) ? 'insecure' : 'invalid';
}

/** 去掉粘贴时混进来的换行与空格：join 串本身没有空白字符。 */
export function normalizeToken(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/** 已 `normalizeToken` 过的串是否是合法 join 串（v1 或 v2）。 */
export function isValidJoinToken(token: string): boolean {
  return JOIN_TOKEN_PATTERN.test(token);
}

export interface BecomeHubValues {
  hubPublicUrl: string;
  username: string;
  password: string;
  confirmPassword: string;
  directEnable: boolean;
}

export type BecomeHubField = 'hubPublicUrl' | 'username' | 'password' | 'confirmPassword';
export type BecomeHubErrors = Partial<Record<BecomeHubField, string>>;

export function validateBecomeHub(values: BecomeHubValues, nodeEnv: NodeEnv): BecomeHubErrors {
  const errors: BecomeHubErrors = {};

  const urlVerdict = classifyHubUrl(values.hubPublicUrl, nodeEnv);
  if (urlVerdict === 'invalid') {
    errors.hubPublicUrl = `${ERROR_PREFIX}invalid_url`;
  }

  if (!USERNAME_PATTERN.test(values.username.trim())) {
    errors.username = `${ERROR_PREFIX}invalid_username`;
  }

  if (values.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `${ERROR_PREFIX}weak_password`;
  }

  if (values.confirmPassword !== values.password) {
    errors.confirmPassword = `${ERROR_PREFIX}password_mismatch`;
  }

  return errors;
}

export interface BecomeRelayValues {
  relayPublicUrl: string;
  /** 空串 = 不设口令，任何人都能接入。 */
  relayPassword: string;
  /** 本机同时作为节点（`relay,node`）。 */
  alsoNode: boolean;
  username: string;
  password: string;
  confirmPassword: string;
  directEnable: boolean;
}

export type BecomeRelayField = 'relayPublicUrl' | 'username' | 'password' | 'confirmPassword';
export type BecomeRelayErrors = Partial<Record<BecomeRelayField, string>>;

/**
 * 中继公网地址：规则与 CLI 的 `normalizeRelayUrl` 一致（https，回环允许 http），
 * 再叠一条 production 下禁止 http——生产实例的中继地址是给外部租户拨的，回环没有意义。
 */
export function classifyRelayUrl(raw: string, nodeEnv: NodeEnv): UrlVerdict {
  const trimmed = raw.trim();
  let canonical: string;
  try {
    canonical = normalizeRelayUrl(trimmed);
  } catch {
    return 'invalid';
  }
  if (new URL(canonical).protocol === 'https:') return 'ok';
  return nodeEnv === 'production' ? 'invalid' : 'insecure';
}

export function validateBecomeRelay(
  values: BecomeRelayValues,
  nodeEnv: NodeEnv
): BecomeRelayErrors {
  const errors: BecomeRelayErrors = {};

  if (classifyRelayUrl(values.relayPublicUrl, nodeEnv) === 'invalid') {
    errors.relayPublicUrl = `${ERROR_PREFIX}invalid_url`;
  }

  // 纯中继不建账号：没有网页，也就没有登录这回事。
  if (!values.alsoNode) return errors;

  if (!USERNAME_PATTERN.test(values.username.trim())) {
    errors.username = `${ERROR_PREFIX}invalid_username`;
  }
  if (values.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `${ERROR_PREFIX}weak_password`;
  }
  if (values.confirmPassword !== values.password) {
    errors.confirmPassword = `${ERROR_PREFIX}password_mismatch`;
  }

  return errors;
}

export interface JoinHubValues {
  hubUrl: string;
  token: string;
  name: string;
  directEnable: boolean;
  insecureLocal: boolean;
}

export type JoinHubField = 'hubUrl' | 'token' | 'name';
export type JoinHubErrors = Partial<Record<JoinHubField, string>>;

export function validateJoinHub(values: JoinHubValues, nodeEnv: NodeEnv): JoinHubErrors {
  const errors: JoinHubErrors = {};

  const urlVerdict = classifyHubUrl(values.hubUrl, nodeEnv);
  if (urlVerdict === 'invalid') {
    errors.hubUrl = `${ERROR_PREFIX}invalid_url`;
  } else if (urlVerdict === 'insecure' && !values.insecureLocal) {
    errors.hubUrl = `${ERROR_PREFIX}insecure_local_required`;
  }

  if (!isValidJoinToken(normalizeToken(values.token))) {
    errors.token = `${ERROR_PREFIX}invalid_token`;
  }

  const name = values.name.trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    errors.name = `${ERROR_PREFIX}invalid_name`;
  }

  return errors;
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some(Boolean);
}

/** 只有当前页面本身就是合法的 hub 公开地址时才预填，避免把 http 内网地址塞给用户。 */
export function defaultHubPublicUrl(origin: string | null, nodeEnv: NodeEnv): string {
  if (!origin) return '';
  return classifyHubUrl(origin, nodeEnv) === 'invalid' ? '' : origin;
}

/** 中继公网地址同理：当前页面地址本身合法时才预填。 */
export function defaultRelayPublicUrl(origin: string | null, nodeEnv: NodeEnv): string {
  if (!origin) return '';
  return classifyRelayUrl(origin, nodeEnv) === 'invalid' ? '' : origin;
}

/** 节点名默认取浏览器地址栏的主机名。 */
export function defaultNodeName(hostname: string | null): string {
  return (hostname ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'node';
}

// ---------------------------------------------------------------------------
// 后端错误码 → i18n key
// ---------------------------------------------------------------------------

const KNOWN_ERROR_CODES = new Set([
  'not_standalone',
  'invalid_url',
  'invalid_role',
  'invalid_username',
  'weak_password',
  'user_exists',
  'invalid_token',
  'node_revoked',
  'node_exists',
  'hub_unreachable',
  'join_failed',
  'env_write_failed',
  'direct_unsupported',
  'direct_download_failed',
  'direct_failed',
]);

/** 已知错误码返回 `nodes.setup.errors.<code>`；未知（含未列举的 `direct_*`）返回 null。 */
export function setupErrorKey(code: string): string | null {
  if (KNOWN_ERROR_CODES.has(code)) return `${ERROR_PREFIX}${code}`;
  return null;
}
