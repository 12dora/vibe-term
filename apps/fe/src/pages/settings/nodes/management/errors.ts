/** 管理动作失败的文案：带 `code` 的错误走 i18n 错误表，其余原样用异常信息。 */
export function actionErrorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  err: unknown
): string {
  const code = (err as { code?: string })?.code;
  if (code) return t(`auth.errors.${code}`, { defaultValue: code });
  return err instanceof Error ? err.message : String(err);
}
