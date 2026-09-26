// 设置向导的纯校验与默认值推导。
//
// 规则与 `POST /api/setup/relay` / `POST /api/setup/relay-join` 的服务端校验逐条对齐：
// 前端先拦一遍只是为了少一次往返，后端仍是权威。

import type { LocalStatusResponse } from '@vibeterm/api-client/local/types';
import { normalizeRelayUrl } from '@vibeterm/shared/relay';

export type NodeEnv = LocalStatusResponse['nodeEnv'];

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 64;

const ERROR_PREFIX = 'nodes.setup.errors.';

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

export type UrlVerdict = 'ok' | 'invalid' | 'insecure';

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

export type BecomeRelayField =
  | 'relayPublicUrl'
  | 'relayPassword'
  | 'username'
  | 'password'
  | 'confirmPassword';
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

  const relayPassword = values.relayPassword.trim();
  if (relayPassword && relayPassword.length < MIN_PASSWORD_LENGTH) {
    errors.relayPassword = `${ERROR_PREFIX}weak_password`;
  }

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

/** 节点名：非空且不超过 64 个字符。 */
function nodeNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return `${ERROR_PREFIX}invalid_name`;
  return null;
}

/** 中继签发的租户编号：16 字节，十六进制展示。 */
const TENANT_ID_PATTERN = /^[0-9a-fA-F]{32}$/;
/** 自签中继的 CA SPKI 指纹。 */
const CA_FINGERPRINT_PATTERN = /^[0-9a-fA-F]{64}$/;

export function normalizeTenantId(raw: string): string {
  return raw.replace(/\s+/g, '').toLowerCase();
}

export interface JoinRelayValues {
  relayUrl: string;
  tenantId: string;
  password: string;
  name: string;
  /** 自签中继才要；留空表示信任系统根证书。 */
  caFingerprint: string;
  directEnable: boolean;
}

export type JoinRelayField = 'relayUrl' | 'tenantId' | 'password' | 'name' | 'caFingerprint';
export type JoinRelayErrors = Partial<Record<JoinRelayField, string>>;

export function validateJoinRelay(values: JoinRelayValues, nodeEnv: NodeEnv): JoinRelayErrors {
  const errors: JoinRelayErrors = {};

  if (classifyRelayUrl(values.relayUrl, nodeEnv) === 'invalid') {
    errors.relayUrl = `${ERROR_PREFIX}invalid_url`;
  }

  if (!TENANT_ID_PATTERN.test(normalizeTenantId(values.tenantId))) {
    errors.tenantId = `${ERROR_PREFIX}invalid_tenant_id`;
  }

  if (!values.password) errors.password = `${ERROR_PREFIX}invalid_password`;

  const nameError = nodeNameError(values.name);
  if (nameError) errors.name = nameError;

  const fingerprint = values.caFingerprint.trim();
  if (fingerprint && !CA_FINGERPRINT_PATTERN.test(fingerprint)) {
    errors.caFingerprint = `${ERROR_PREFIX}invalid_ca_fingerprint`;
  }

  return errors;
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some(Boolean);
}

/** 中继公网地址：当前页面地址本身合法时才预填。 */
export function defaultRelayPublicUrl(origin: string | null, nodeEnv: NodeEnv): string {
  if (!origin) return '';
  return classifyRelayUrl(origin, nodeEnv) === 'invalid' ? '' : origin;
}

/** 节点名默认取浏览器地址栏的主机名。 */
export function defaultNodeName(hostname: string | null): string {
  return (hostname ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'node';
}

const KNOWN_ERROR_CODES = new Set([
  'not_standalone',
  'invalid_body',
  'invalid_password',
  'invalid_url',
  'invalid_role',
  'invalid_username',
  'weak_password',
  'user_exists',
  'invalid_token',
  'node_revoked',
  'node_exists',
  'join_failed',
  'env_write_failed',
  'direct_unsupported',
  'direct_download_failed',
  'direct_failed',
  'setup_committed',
  'setup_in_progress',
  'relay_password_invalid',
  'relay_tenant_unknown',
  'relay_pack_invalid',
  'relay_unreachable',
  'relay_not_authorized',
  'local_user_exists',
  'LOOPBACK_REQUIRED',
  'UNAUTHORIZED',
]);

/** 已知错误码返回 `nodes.setup.errors.<code>`；未知（含未列举的 `direct_*`）返回 null。 */
export function setupErrorKey(code: string): string | null {
  if (KNOWN_ERROR_CODES.has(code)) return `${ERROR_PREFIX}${code}`;
  return null;
}
