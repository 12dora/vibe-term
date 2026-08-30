export function normalizeHistoryForTerminal(data: string): string {
  if (!data) return data;
  const canonical = data.replace(/\r\n/g, '\n');
  const trimmed = canonical.endsWith('\n') ? canonical.slice(0, -1) : canonical;
  return trimmed.replace(/\n/g, '\r\n');
}

const ALT_SCREEN_HISTORY_PREAMBLE = '\x1b[?1049h\x1b[H\x1b[2J';

export function wrapAlternateScreenHistory(data: string): string {
  return ALT_SCREEN_HISTORY_PREAMBLE + normalizeHistoryForTerminal(data);
}

// 补 CR 的常驻暂存区：live 输出每帧都要走一遍，逐帧新建缓冲会把 GC 压力堆到渲染线程上。
// 超过上限的一次性大载荷（history 重排的快照正文可达 MB 级）单独分配，避免把常驻缓冲永久撑大。
const NORMALIZE_SCRATCH_MAX_BYTES = 256 * 1024;
let normalizeScratch = new Uint8Array(0);

function normalizeScratchOf(bytes: number): Uint8Array {
  if (bytes > NORMALIZE_SCRATCH_MAX_BYTES) return new Uint8Array(bytes);
  if (normalizeScratch.length < bytes) normalizeScratch = new Uint8Array(bytes);
  return normalizeScratch;
}

function indexOfBareLF(data: Uint8Array, previousEndedWithCR: boolean): number {
  let prevWasCR = previousEndedWithCR;
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    if (byte === 0x0a && !prevWasCR) return index;
    prevWasCR = byte === 0x0d;
  }
  return -1;
}

/**
 * 裸 LF 补齐 CR。整块无裸 LF 时原样返回，否则只从第一个裸 LF 起改写。
 * 返回的缓冲可能是复用的暂存区视图，只在下一次调用前有效——调用方必须同步消费。
 */
export function normalizeLiveOutputForTerminal(
  data: Uint8Array,
  previousEndedWithCR: boolean
): { normalized: Uint8Array; endedWithCR: boolean } {
  const endedWithCR = data.length === 0 ? previousEndedWithCR : data[data.length - 1] === 0x0d;
  const start = indexOfBareLF(data, previousEndedWithCR);
  if (start < 0) return { normalized: data, endedWithCR };

  const normalized = normalizeScratchOf(data.length + (data.length - start));
  normalized.set(data.subarray(0, start));
  let writeIndex = start;
  // start 处必然是裸 LF，其前一个字节按定义不是 CR
  let prevWasCR = false;
  for (let index = start; index < data.length; index += 1) {
    const byte = data[index];
    if (byte === 0x0a && !prevWasCR) {
      normalized[writeIndex] = 0x0d;
      writeIndex += 1;
    }
    normalized[writeIndex] = byte;
    writeIndex += 1;
    prevWasCR = byte === 0x0d;
  }

  return { normalized: normalized.subarray(0, writeIndex), endedWithCR };
}
