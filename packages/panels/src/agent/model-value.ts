const SEP = '::';

export function encodeModelValue(providerId: string | null, modelId: string): string {
  return `${providerId ?? ''}${SEP}${modelId}`;
}

export function decodeModelValue(value: string): { providerId: string | null; modelId: string } {
  const idx = value.indexOf(SEP);
  if (idx < 0) return { providerId: null, modelId: value };
  const providerId = value.slice(0, idx);
  return { providerId: providerId || null, modelId: value.slice(idx + SEP.length) };
}
