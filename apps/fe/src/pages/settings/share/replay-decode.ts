// 日志载荷的解码：base64 → 字节，以及把被分享人的输入渲染成可读的一行标记。
// 输入只作展示，永远不写回终端。

export function decodeBase64(data: string): Uint8Array {
  if (data === '') return new Uint8Array(0);
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const INPUT_TEXT_MAX = 120;

/** 控制字符换成看得懂的记号：回车 ⏎、Tab ⇥、退格 ⌫、其余 C0 用 `^X`。 */
export function describeInputBytes(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\r' || char === '\n') out += '⏎';
    else if (char === '\t') out += '⇥';
    else if (code === 0x7f) out += '⌫';
    else if (code === 0x1b) out += '⎋';
    else if (code < 0x20) out += `^${String.fromCharCode(code + 64)}`;
    else out += char;
    if (out.length >= INPUT_TEXT_MAX) return `${out.slice(0, INPUT_TEXT_MAX)}…`;
  }
  return out;
}

export function describeInputBase64(data: string): string {
  return describeInputBytes(decodeBase64(data));
}
