export function redactSecrets(line: string): string {
  return line.replace(/[A-Za-z0-9+/]{32,}={0,2}|\b[0-9a-fA-F]{32,}\b/g, '***');
}
