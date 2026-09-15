import type { WindowMemorySettings } from '@vibeterm/shared';

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildSetPropertyArgs(
  scope: string,
  settings: WindowMemorySettings
): string[] | null {
  const properties: string[] = [];
  if (settings.memoryHighMb > 0) {
    properties.push(`MemoryHigh=${settings.memoryHighMb}M`);
  }
  if (settings.memoryMaxMb > 0) {
    properties.push(`MemoryMax=${settings.memoryMaxMb}M`);
  }
  if (settings.memorySwapMaxMb > 0) {
    properties.push(`MemorySwapMax=${settings.memorySwapMaxMb}M`);
  }
  if (properties.length === 0) {
    return null;
  }
  return ['systemctl', '--user', 'set-property', '--runtime', scope, ...properties];
}

export function buildStopScopeScript(scopes: string[]): string {
  if (scopes.length === 0) {
    return 'true';
  }
  return `systemctl --user stop ${scopes.map(shQuote).join(' ')}`;
}

export function argvToScript(argv: string[]): string {
  return argv.map(shQuote).join(' ');
}
