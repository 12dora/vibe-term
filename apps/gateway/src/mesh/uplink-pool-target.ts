/**
 * 池的「当前目标」：已挂上的中继，否则正在拨 / 上次尝试的 URL。
 * 仅在空闲或已 stop 时为 null，供 secondary 排除用，避免重拨空窗把副中继全拆。
 */
export function primaryTargetOf(
  attachedUrl: string | null | undefined,
  diallingUrl: string | null | undefined,
  running: boolean
): string | null {
  if (attachedUrl) return attachedUrl;
  if (!running) return null;
  return diallingUrl ?? null;
}
