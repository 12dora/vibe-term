export function buildJsonStreamBody(
  input: unknown,
  headers: Record<string, string>
): ReadableStream<Uint8Array> {
  const payload = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  headers['content-type'] = 'application/json';
  const bytes = new TextEncoder().encode(payload);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
