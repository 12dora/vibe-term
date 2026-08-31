// 步骤 5 的命令预览：加入码还没生成时也要给出**形状完全正确**的命令。
//
// 预览不自己拼字符串，而是拿哨兵值走真正的 `joinCommand()`，再把哨兵换成本地化占位符：
// 引号规则、参数顺序、`--name` 的取舍全部与真实命令逐字一致，不会两处各写一套。

import { isTrustedHubUrl, joinCommand } from '@/node/enrollment';

/** hub 对外地址未知时的示例地址。 */
export const EXAMPLE_HUB_URL = 'https://tmex.example.com';

/** 哨兵只含 `[A-Za-z0-9._-]`，`joinCommand()` 的引用规则不会碰它们。 */
const TOKEN_SENTINEL = '__TMEX_JOIN_TOKEN__';
const NAME_SENTINEL = '__TMEX_NODE_NAME__';

export interface JoinCommandPreviewInput {
  /** `/api/auth/mode` 或 enrollment 响应给出的 hub 对外地址；不可信时退回示例地址。 */
  hubPublicUrl: string | null;
  /** 用户当前输入的节点名；为空时用占位符。 */
  name: string;
  tokenPlaceholder: string;
  namePlaceholder: string;
}

export function joinCommandPreview(input: JoinCommandPreviewInput): string {
  const hubUrl = isTrustedHubUrl(input.hubPublicUrl)
    ? (input.hubPublicUrl as string)
    : EXAMPLE_HUB_URL;
  const name = input.name.trim();
  const command = joinCommand(hubUrl, TOKEN_SENTINEL, name || NAME_SENTINEL).replace(
    TOKEN_SENTINEL,
    input.tokenPlaceholder
  );
  return name ? command : command.replace(NAME_SENTINEL, input.namePlaceholder);
}
