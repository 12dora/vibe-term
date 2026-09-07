// 中继模式下密钥日志记录的「送达中继」判定。
//
// `POST /api/auth/keylog?hub=sync` 的 `hubAck:true` 只说明**本机**落了库；中继模式还会另带一个
// `relayAck`，为 false 时这条记录没上中继，成员节点一条都收不到——改中继接入密码那次事故里，
// 成员永久离线正是因为这个失败被静默吞掉、界面还报成功。
//
// 三条硬性质：
// - 非中继模式（以及旧节点）根本不下发该字段：`undefined` 一律按已送达处理，不能退化成告警。
// - 记录已在本地生效，所以这不是失败，只挂告警；重发同一条记录会重新尝试发布。
// - 错误原文由上联给出（`offline` / `timeout` / `unavailable` / `not_published` / `SEQ_MISMATCH`），
//   逐条翻译比一句「同步失败」有用。

import i18n from 'i18next';
import { toast } from 'sonner';

/** `hub=sync` 响应里与中继确认有关的两个字段（`KeyLogAppendResult` 的成功分支即是这个形状）。 */
export interface RelayAckFields {
  relayAck?: boolean;
  relayError?: string;
}

/** 中继明确没确认，但没给出原因。 */
export const RELAY_ACK_UNKNOWN = 'unknown';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 中继没确认时返回上联错误码；已确认或字段缺失（非中继 / 旧节点）返回 `null`。 */
export function relayAckError(result: RelayAckFields | null | undefined): string | null {
  if (!result || result.relayAck !== false) return null;
  return result.relayError || RELAY_ACK_UNKNOWN;
}

/** 上联错误码的可读文案；没有对应条目时原样显示 code。 */
export function relayAckErrorText(t: Translate, code: string): string {
  return t(`relay.tenant.relayAck.errors.${code}`, { defaultValue: code });
}

/**
 * 中继没确认就挂一条告警 toast，返回是否告警过。
 *
 * 所有在中继模式下追加密钥日志的 web 路径都过这一道：改密、换成员密钥、吊销、准入、接入、
 * 离开、重发令牌。调用点在自己的成功提示**之外**再调它，不要把成功提示替换掉——
 * 本地确实已经生效，只是成员还没拿到。
 */
export function warnRelayAck(t: Translate, result: RelayAckFields | null | undefined): boolean {
  const code = relayAckError(result);
  if (code === null) return false;
  toast.warning(t('relay.tenant.relayAck.warning', { error: relayAckErrorText(t, code) }));
  return true;
}

/**
 * 流程模块（非 React）里发同一条告警。
 *
 * `submitSignedRecord()` 是所有中继密钥日志写入的必经之路，把告警放在那里就不必让每个
 * 调用点各记一次；那里拿不到 `useTranslation()` 的 `t`，只能用全局实例（与
 * `node-runtimes.ts` 同一套做法）。
 */
export function warnRelayAckGlobal(result: RelayAckFields | null | undefined): boolean {
  return warnRelayAck(globalTranslate, result);
}

const globalTranslate: Translate = (key, options) => String(i18n.t(key as never, options as never));
