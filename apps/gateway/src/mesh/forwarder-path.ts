export function parseNodePrefix(pathname: string): { nodeId: string; rest: string } | null {
  const match = pathname.match(/^\/n\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  return { nodeId: decodeURIComponent(match[1] ?? ''), rest: match[2] || '/' };
}
