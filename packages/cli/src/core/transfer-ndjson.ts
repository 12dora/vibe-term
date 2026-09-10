// POST 响应里的 NDJSON（upload commit / download prepare / transfer events）。

export async function consumeNdjson<T>(
  response: Response,
  onEvent: (event: T) => void
): Promise<void> {
  const body = response.body;
  if (!body) {
    const text = await response.text();
    for (const line of text.split('\n')) {
      if (line.trim()) onEvent(JSON.parse(line) as T);
    }
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) buffer += decoder.decode(value, { stream: true });
    buffer = drainLines(buffer, onEvent);
  }
  const tail = (buffer + decoder.decode()).trim();
  if (tail) onEvent(JSON.parse(tail) as T);
}

function drainLines<T>(buffer: string, onEvent: (event: T) => void): string {
  let newline = buffer.indexOf('\n');
  let rest = buffer;
  while (newline >= 0) {
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (line) onEvent(JSON.parse(line) as T);
    newline = rest.indexOf('\n');
  }
  return rest;
}
