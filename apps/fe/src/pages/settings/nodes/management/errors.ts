import { HUB_NOT_WRITER } from '@tmex/api-client/auth/index';

export interface ActionErrorContext {
  /** writer hub 的对外地址；`HUB_NOT_WRITER` 的文案靠它指路，未知时退回不带地址的那句。 */
  writerPublicUrl?: string | null;
}

/** 管理动作失败的文案：带 `code` 的错误走 i18n 错误表，其余原样用异常信息。 */
export function actionErrorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  err: unknown,
  context: ActionErrorContext = {}
): string {
  const code = (err as { code?: string })?.code;
  // standby 拒写：知道 writer 地址就把地址写进提示，用户才知道该去哪台机器操作。
  if (code === HUB_NOT_WRITER && context.writerPublicUrl) {
    return t('nodes.hubs.notWriter', { url: context.writerPublicUrl });
  }
  if (code) return t(`auth.errors.${code}`, { defaultValue: code });
  return err instanceof Error ? err.message : String(err);
}
