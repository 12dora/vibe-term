// DEC 2026 同步输出结束序列 ESC [ ? 2026 l。TUI（Claude Code 等）每帧用它收尾，
// 帧一旦完整就该立即下发，不必等 16 ms 冷却——否则两帧并成一次，浏览器只画得到一半的帧。
const SYNC_END = new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]);

function matchesAt(bytes: Uint8Array, offset: number): boolean {
  for (let index = 0; index < SYNC_END.length; index += 1) {
    if (bytes[offset + index] !== SYNC_END[index]) return false;
  }
  return true;
}

/** `data` 是否含有帧结束序列；序列可能跨在上一段 `previous` 的尾巴与本段开头之间 */
export function endsSynchronizedFrame(previous: Uint8Array | undefined, data: Uint8Array): boolean {
  if (previous && previous.byteLength > 0) {
    const tailLength = Math.min(SYNC_END.length - 1, previous.byteLength);
    const headLength = Math.min(SYNC_END.length - 1, data.byteLength);
    const joined = new Uint8Array(tailLength + headLength);
    joined.set(previous.subarray(previous.byteLength - tailLength), 0);
    joined.set(data.subarray(0, headLength), tailLength);
    for (let offset = 0; offset + SYNC_END.length <= joined.byteLength; offset += 1) {
      if (matchesAt(joined, offset)) return true;
    }
  }
  const last = data.byteLength - SYNC_END.length;
  for (let offset = 0; offset <= last; offset += 1) {
    if (data[offset] === 0x1b && matchesAt(data, offset)) return true;
  }
  return false;
}
