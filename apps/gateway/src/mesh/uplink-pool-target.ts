/**
 * 池当前占用的 URL：正在拨或切换的目标优先，否则已挂上的。
 * 只排除这一条，重拨空窗不会把其余副中继拆掉。空闲或已 stop 时为 null。
 */
export function primaryTargetOf(
  attachedUrl: string | null | undefined,
  diallingUrl: string | null | undefined,
  running: boolean
): string | null {
  if (!running) return null;
  if (diallingUrl) return diallingUrl;
  return attachedUrl ?? null;
}
