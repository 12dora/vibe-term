/**
 * `GET /api/auth/keylog/head`。
 * 构造任何 `user_key_log` 记录都要 `prev_hash` 与当前 epoch，缺它前端签不出记录。
 */
export interface KeyLogHeadResponse {
  seq: number | string;
  /** base64url，32 字节；genesis 为 32 个 0 */
  hash: string;
  rootEpoch: number;
  uid?: string;
}

/** `POST /api/auth/keylog` 请求体。 */
export interface KeyLogAppendRequest {
  /** base64url(borsh(KeyLogRecord)) */
  bytes: string;
  /** base64url(sig)：root=64B Ed25519；passkey=borsh(PasskeyAssertion) */
  sig: string;
}

/**
 * `POST /api/auth/keylog` 结果。
 *
 * `hub=sync` 模式下 entry 先把记录送 hub 并等 ack，再本地 append，响应带 `hubAck`：
 * 只有 `hubAck === true` 才代表 hub 已持久化该记录，admit / revoke 必须据此决定是否清 pending。
 */
export type KeyLogAppendResult =
  | {
      ok: true;
      seq?: number | string;
      hash?: string;
      hubAck?: boolean;
      hubError?: string;
      /**
       * 中继模式专有：记录已本地落库，`relayAck` 才说明上级中继也确认了。
       * `false` 时成员节点**收不到**这条记录，调用方必须显式告警（旧节点不下发该字段）。
       */
      relayAck?: boolean;
      /** `relayAck:false` 时的上联原始错误（`offline` / `timeout` / `unavailable` 等）。 */
      relayError?: string;
    }
  | { ok: false; code: 'KEY_LOG_FORK' | (string & {}) };
