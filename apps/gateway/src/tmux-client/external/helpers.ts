export function hasRenderableTerminalContent(value: string): boolean {
  return value.trim().length > 0;
}

// 套接字路径不可达（如 /tmp 被新挂载遮蔽、目录被清理）：server 进程还在，已挂上的控制模式
// client 照常工作，只有新起的一次性 tmux 命令连不上。与 server 真的没了是两回事，不可混判。
export function isTmuxSocketMissingMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('error connecting to') && normalized.includes('no such file or directory')
  );
}

export function isTmuxServerGoneMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('no server running on') ||
    normalized.includes('no sessions') ||
    normalized.includes('lost server') ||
    normalized.includes("can't find session") ||
    normalized.includes('session not found') ||
    normalized.includes('no such session')
  );
}
