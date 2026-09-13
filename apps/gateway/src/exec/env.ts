export function mergedServiceEnv(overlay?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  if (overlay) Object.assign(out, overlay);
  return out;
}
