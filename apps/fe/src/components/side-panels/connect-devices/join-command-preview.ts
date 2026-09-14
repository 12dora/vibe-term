// 步骤 5 的命令预览：加入码还没生成时也要给出**形状完全正确**的命令。
//
// 预览不自己拼字符串，而是拿哨兵值走真正的 `joinCommand()`，再把哨兵换成本地化占位符：
// 引号规则、参数顺序、`--name` 的取舍全部与真实命令逐字一致，不会两处各写一套。

import { isTrustedPublicUrl, joinCommand } from '@/node/enrollment';

/** 加入命令里对外地址未知时的示例地址。 */
export const EXAMPLE_PUBLIC_URL = 'https://vibeterm.example.com';

/** 中继地址未知时的示例地址。 */
export const EXAMPLE_RELAY_URL = 'https://relay.example.com';

/** 哨兵只含 `[A-Za-z0-9._-]`，`joinCommand()` 的引用规则不会碰它们。 */
const TOKEN_SENTINEL = '__VIBETERM_JOIN_TOKEN__';
const NAME_SENTINEL = '__VIBETERM_NODE_NAME__';

export interface JoinCommandPreviewInput {
  /** enrollment 响应给出的对外地址；不可信时退回示例地址。 */
  publicUrl: string | null;
  /** 用户当前输入的节点名；为空时用占位符。 */
  name: string;
  tokenPlaceholder: string;
  namePlaceholder: string;
}

export function joinCommandPreview(input: JoinCommandPreviewInput): string {
  const publicUrl = isTrustedPublicUrl(input.publicUrl)
    ? (input.publicUrl as string)
    : EXAMPLE_PUBLIC_URL;
  const name = input.name.trim();
  const command = joinCommand(publicUrl, TOKEN_SENTINEL, name || NAME_SENTINEL).replace(
    TOKEN_SENTINEL,
    input.tokenPlaceholder
  );
  return name ? command : command.replace(NAME_SENTINEL, input.namePlaceholder);
}

/** `joinCommand()` 同款引用规则；密码路径不带 token，无法复用它，只好重写这一行。 */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** 用账号密码加入中继租户的命令。租户编号未知时填占位符，形状仍然正确。 */
export function relayJoinCommand(input: {
  relayUrl: string | null;
  tenantId: string | null;
  tenantPlaceholder: string;
}): string {
  const url = isTrustedPublicUrl(input.relayUrl) ? (input.relayUrl as string) : EXAMPLE_RELAY_URL;
  const tenant = input.tenantId ?? input.tenantPlaceholder;
  return `vibeterm relay join ${shellQuote(url)} --tenant ${shellQuote(tenant)}`;
}

/** 本机以租户身份接进一条中继的命令；地址未知时填示例地址，形状仍然正确。 */
export function relayEnrollCommand(relayUrl: string | null): string {
  const url = isTrustedPublicUrl(relayUrl) ? (relayUrl as string) : EXAMPLE_RELAY_URL;
  return `vibeterm relay enroll ${shellQuote(url)}`;
}
