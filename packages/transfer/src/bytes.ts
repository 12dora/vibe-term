// 字节小工具：仓库里原本有七八份同样的 concat / copy，统一收到这里。

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** 脱离底层 ArrayBuffer 的副本：网络栈复用缓冲区时必须先拷贝再排队。 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

export function toBytes(input: unknown): Uint8Array | null {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}
