// 网关（服务端）实际渲染的 key 前缀表：通知、推送、Telegram/微信消息、API 错误、SSH 错误。
// `bun run build:i18n` 据此生成 locales/generated/<locale>.server.ts，网关只加载这部分文案。
// apps/gateway/src/i18n/server-keys-coverage.test.ts 扫描网关源码，用到表外 key 即失败。
// 改动这里必须重新跑 `bun run build:i18n`。

import { type TranslationTree, matchesI18nPrefix, partitionTranslation } from './core-keys';

export const I18N_SERVER_KEY_PREFIXES: readonly string[] = [
  'agent.error.streamStalled',
  'apiError',
  'common.success',
  'deviceStatus.errorBadge',
  'messaging',
  'notification',
  'settings.restartScheduled',
  'sshError',
  'telegram.agentCredentialWarning',
  'telegram.approveMessageTemplate',
  'telegram.authFailed',
  'telegram.authPending',
  'telegram.authSuccess',
  'telegram.botNotRunning',
  'telegram.deviceConnectionError',
  'telegram.gatewayOnline',
  'telegram.testMessageTemplate',
  'weixin.accountNameRequired',
  'weixin.accountNotFound',
  'weixin.accountNotRunning',
  'weixin.approveMessageTemplate',
  'weixin.gatewayOnline',
  'weixin.keepalivePrompt',
  'weixin.loginFailed',
  'weixin.testMessageFailed',
  'weixin.testMessageTemplate',
  'weixin.userNotFound',
];

export function isServerI18nKey(key: string): boolean {
  return matchesI18nPrefix(I18N_SERVER_KEY_PREFIXES, key);
}

/** 从完整翻译树里取出网关用到的子树。 */
export function pickServerTranslation(tree: TranslationTree): TranslationTree {
  return partitionTranslation(tree, isServerI18nKey).matched;
}
