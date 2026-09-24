import type { WindowMemorySettings } from '@vibeterm/shared';

import { withUserBus } from './user-bus';

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function isAllZeroLimits(settings: WindowMemorySettings): boolean {
  return settings.memoryHighMb <= 0 && settings.memoryMaxMb <= 0 && settings.memorySwapMaxMb <= 0;
}

function memoryProperty(name: string, mb: number): string {
  return `${name}=${mb > 0 ? `${mb}M` : 'infinity'}`;
}

export function buildSetPropertyArgs(
  scope: string,
  settings: WindowMemorySettings
): string[] | null {
  if (isAllZeroLimits(settings)) return null;
  return [
    'systemctl',
    '--user',
    'set-property',
    '--runtime',
    scope,
    memoryProperty('MemoryHigh', settings.memoryHighMb),
    memoryProperty('MemoryMax', settings.memoryMaxMb),
    memoryProperty('MemorySwapMax', settings.memorySwapMaxMb),
  ];
}

export function buildReleasePropertyArgs(scope: string): string[] {
  return [
    'systemctl',
    '--user',
    'set-property',
    '--runtime',
    scope,
    'MemoryHigh=infinity',
    'MemoryMax=infinity',
    'MemorySwapMax=infinity',
  ];
}

export function buildStopScopeScript(scopes: string[]): string {
  if (scopes.length === 0) {
    return 'true';
  }
  return withUserBus(`systemctl --user stop ${scopes.map(shQuote).join(' ')}`);
}

export function argvToScript(argv: string[]): string {
  return argv.map(shQuote).join(' ');
}
