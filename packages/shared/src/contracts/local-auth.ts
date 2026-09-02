// standalone 本机登录开关（`GET /api/auth/mode` 的加性字段）。
// FE 向导：hub/node（supported=false）→「已由节点登录保护」；
// standalone+effective → 已保护；standalone+!effective → 提供开启。

/** `GET /api/auth/mode` / `POST /api/auth/local` 下发的本机登录状态。 */
export interface LocalAuthStatus {
  /** 仅 standalone 可开关本机登录；hub/node 恒为 false。 */
  supported: boolean;
  /** 持久化开关（默认 false）。无凭证时禁止置 true。 */
  enabled: boolean;
  /** standalone && enabled && credentialsPresent。为 true 时登录门生效。 */
  effective: boolean;
  /** 是否已有可登录用户（root 口令 / passkey / TOTP 用户行）。 */
  credentialsPresent: boolean;
}

/** `POST /api/auth/local` 请求体。 */
export interface SetLocalAuthRequest {
  enabled: boolean;
}

/** `POST /api/auth/local/bootstrap` 请求体：在门未生效时创建第一位用户。 */
export interface BootstrapLocalAuthRequest {
  username: string;
  password: string;
}

/**
 * `GET /api/auth/totp-record`（需会话）。
 * 常规改密重封装 TOTP 时取当前密文；`payload` 为 base64url(borsh(SetTotpPayload))。
 */
export interface AuthTotpRecordResponse {
  record_seq: string | number;
  root_epoch: number;
  payload: string;
}
