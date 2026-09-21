// 单 node 登录失败的分类：传输层打不通，还是这份会话真的不能用了。
//
// 两者的下一步完全相反：打不通只能等链路回来（点多少次「登录该节点」都没用，反而在中继上
// 叠拨号），会话失效则必须用户去登一次。此前所有认不出的码都落到 `auth.errors.LOGIN_FAILED`
// 的「登录失败。」，于是一次 mesh 抖动在界面上被说成「这台节点登录失败」——用户照着提示反复
// 点登录，把刚刚被打满的上行继续压住。
//
// 判定用白名单，两张表都认不出时按 `other`：那是服务端给过的业务结论（限流、公钥不匹配……），
// 照旧显示它自己的原因，但绝不谎称成「连接不上」。
//
// 本模块**不许有任何 import**：`session-key-store` 要 import `node-login-retry`（登录记账收在
// `ensureNodeLogin` 里），`node-login-retry` 又要 import 这里的分类。文案映射因此单独放
// `./login-failure-text`，它才碰得到 `session-key-store`。

export type NodeLoginFailureKind =
  /** 根本没问到目标：转发器打不通、断网、超时、mesh 列表拉不到。 */
  | 'unreachable'
  /** 会话 / 凭证本身不能用：必须用户介入登录。 */
  | 'credential'
  /** 服务端给过的其它结论：照原因显示，不归到上面任何一类。 */
  | 'other';

const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'NODE_UNREACHABLE',
  'NETWORK_ERROR',
  'NODE_LIST_FAILED',
  'NO_CONNECTION',
  'RELAY_UNREACHABLE',
  'LINK_LOST',
  'TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

const CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  'NO_SESSION_KEY',
  'UNAUTHORIZED',
  'NODE_LOGIN_REQUIRED',
  'LOGIN_FAILED',
  'INVALID_CREDENTIALS',
  'UNKNOWN_USER',
  'ROOT_KEY_MISMATCH',
  'TOTP_REQUIRED',
  'TOTP_INVALID',
  'TOTP_CODE_REQUIRED',
  'PASSKEY_REQUIRED',
  'PASSKEY_INVALID',
  'PASSKEY_VERIFY_FAILED',
  'PASSKEY_ABORTED',
  'PASSKEY_CREDENTIAL_UNKNOWN',
  'NO_PASSKEY_FOR_ORIGIN',
  'BAD_SIGNATURE',
  'BAD_DELEGATION',
  'DELEGATION_EXPIRED',
  'DELEGATION_BAD_SIGNATURE',
  'DELEGATION_METHOD_MISMATCH',
  'DELEGATION_ISSUED_IN_FUTURE',
  'DELEGATION_INVALID_TTL',
]);

/**
 * `HTTP_502` / `HTTP_504` 这类只剩状态码的失败没有业务含义：反代或入口没把请求送到，
 * 与断网同一档。4xx 例外——那是对方答过话的结论。
 */
function isTransportHttpCode(code: string): boolean {
  if (!code.startsWith('HTTP_')) return false;
  const status = Number(code.slice(5));
  return Number.isFinite(status) && status >= 500;
}

export function classifyNodeLoginFailure(code: string | null | undefined): NodeLoginFailureKind {
  if (!code) return 'other';
  if (UNREACHABLE_CODES.has(code) || isTransportHttpCode(code)) return 'unreachable';
  if (CREDENTIAL_CODES.has(code)) return 'credential';
  return 'other';
}

/** 这次失败是链路问题：不要说「登录失败」，也不要引导用户去点登录。 */
export function isUnreachableLoginFailure(code: string | null | undefined): boolean {
  return classifyNodeLoginFailure(code) === 'unreachable';
}

/** 该不该给「登录该节点」入口。打不通时点了也只是再叠一次拨号。 */
export function offerNodeLogin(code: string | null | undefined): boolean {
  return classifyNodeLoginFailure(code) !== 'unreachable';
}
