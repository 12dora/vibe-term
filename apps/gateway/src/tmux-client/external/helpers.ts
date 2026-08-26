export function hasRenderableTerminalContent(value: string): boolean {
  return value.trim().length > 0;
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
