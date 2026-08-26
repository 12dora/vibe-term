// NDJSON 流读取：上传 commit 与下载 prepare 共用同一套分帧逻辑。
// 只做「按行切分 + JSON.parse」，不解释事件语义；末尾未以换行结束的残段按不完整帧丢弃。

export async function readNdjsonStream<T>(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: T) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as T);
    }
  }
}
