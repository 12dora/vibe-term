/** 把任意 catch 到的值收敛成一句人类可读的错误文本：`Error` 取 `message`，其余走 `String()`。 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
