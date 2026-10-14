// 命令自己声明的失败输出格式（Command.errorPrefix）：一行 `<前缀>: <原因>`，只有认证类错误附带下一步提示。

import { AuthError, errorText, hintOf } from './errors';
import type { Output } from './output';

export function reportPrefixedFailure(out: Output, prefix: string, error: unknown): void {
  out.error(`${prefix}: ${errorText(error)}`);
  const hint = error instanceof AuthError ? hintOf(error) : undefined;
  if (hint) out.error(`  ${hint}`);
}
