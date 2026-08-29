const GHOSTTY_SUCCESS = 0;
const GHOSTTY_OUT_OF_SPACE = -3;

export type WasmOutputMemory = {
  allocUsize(): number;
  freeUsize(ptr: number): void;
  allocBytes(len: number): number;
  freeBytes(ptr: number, len: number): void;
  readUsize(ptr: number): number;
  readOwnedUtf8(ptr: number, len: number): string;
};

export type WasmOutputEncoding = {
  label: string;
  assertResult(result: number, action: string): void;
  encode(outPtr: number, capacity: number, outWrittenPtr: number): number;
};

// 两趟 UTF-8 输出 ABI：先以零容量问出所需字节数（允许 OUT_OF_SPACE），再分配缓冲区
// 写入并按写入长度解码。返回 null 表示编码器没有产出任何字节。
export function encodeOwnedUtf8Output(
  memory: WasmOutputMemory,
  encoding: WasmOutputEncoding
): string | null {
  const requiredPtr = memory.allocUsize();

  try {
    const sizeResult = encoding.encode(0, 0, requiredPtr);
    if (sizeResult !== GHOSTTY_OUT_OF_SPACE && sizeResult !== GHOSTTY_SUCCESS) {
      encoding.assertResult(sizeResult, `${encoding.label}(size)`);
    }

    const required = Math.max(0, memory.readUsize(requiredPtr));
    if (required === 0) {
      return null;
    }

    const bufferPtr = memory.allocBytes(required);
    const writtenPtr = memory.allocUsize();

    try {
      encoding.assertResult(encoding.encode(bufferPtr, required, writtenPtr), encoding.label);

      const written = memory.readUsize(writtenPtr);
      if (written === 0) {
        return null;
      }

      return memory.readOwnedUtf8(bufferPtr, written);
    } finally {
      memory.freeBytes(bufferPtr, required);
      memory.freeUsize(writtenPtr);
    }
  } finally {
    memory.freeUsize(requiredPtr);
  }
}
