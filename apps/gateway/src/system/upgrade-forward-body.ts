const REMOTE_UPGRADE_JSON_MAX_BYTES = 64 * 1024;

export function discardUpstreamBody(res: Response): void {
  void res.body?.cancel().catch(() => {});
}

type BoundedJson = { ok: true; value: Record<string, unknown> } | { ok: false };

export async function readBoundedJsonObject(res: Response): Promise<BoundedJson> {
  const raw = await readBodyLimited(res, REMOTE_UPGRADE_JSON_MAX_BYTES);
  if (!raw.ok) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(raw.text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
  } catch {
    // unparsable or empty
  }
  return { ok: false };
}

async function readBodyLimited(
  response: Response,
  limit: number
): Promise<{ ok: true; text: string } | { ok: false }> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      if (total + value.byteLength > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false };
  }
  return { ok: true, text: new TextDecoder().decode(Buffer.concat(chunks, total)) };
}
