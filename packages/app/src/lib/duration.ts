const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

export function parseDurationMs(input: string, fallbackUnit = 'm'): number {
  const trimmed = input.trim();
  const match = /^(\d+)(ms|s|m|h)?$/i.exec(trimmed);
  if (!match) {
    throw new Error(`invalid duration: ${input}`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? fallbackUnit).toLowerCase();
  const factor = UNIT_MS[unit];
  if (!factor) {
    throw new Error(`invalid duration: ${input}`);
  }
  return amount * factor;
}
