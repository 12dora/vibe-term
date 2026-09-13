export { parseNodeIdFromPath } from '@vibeterm/api-client';

/**
 * URL 段上的 pane / window id 解码。tmux pane id 形如 `%2`，编码后是 `%252`；
 * 手工或部分 UA 露出的 `%2` / `%zz` 会让 decodeURIComponent 抛 URIError，
 * 这里降级成原样返回，让导航继续而不是把整页打进错误卡。
 */
export function safeDecodePaneParam(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
