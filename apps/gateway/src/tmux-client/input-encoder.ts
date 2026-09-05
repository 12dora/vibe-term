export const SEND_KEYS_HEX_CHUNK_BYTES = 256;
/** 流水线化输入（粘贴）里每条 send-keys 的回执超时：整段一起排队，末条要等前面全跑完。 */
export const PIPELINED_INPUT_TIMEOUT_MS = 30_000;

export function encodeBytesToHexChunks(
  bytes: Uint8Array,
  chunkBytes = SEND_KEYS_HEX_CHUNK_BYTES
): string[][] {
  const chunks: string[][] = [];

  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const chunk = bytes.slice(offset, offset + chunkBytes);
    chunks.push(Array.from(chunk, (byte) => byte.toString(16).padStart(2, '0')));
  }

  return chunks;
}

/**
 * 一段输入拆成若干条 `send-keys -H` 的 argv。每条命令的十六进制实参不超过
 * `SEND_KEYS_HEX_CHUNK_BYTES * 3` 字符（256 字节 = 768 字符），远低于 tmux 的命令长度上限；
 * 粘贴不再由调用方按字符切块，整段交给连接后由这里统一切。
 */
export function buildSendKeysCommands(
  paneId: string,
  bytes: Uint8Array,
  chunkBytes = SEND_KEYS_HEX_CHUNK_BYTES
): string[][] {
  return encodeBytesToHexChunks(bytes, chunkBytes).map((chunk) => [
    'send-keys',
    '-H',
    '-t',
    paneId,
    ...chunk,
  ]);
}

/**
 * 控制模式下整段输入的命令一次写完，只等最后一条回执：逐块串行等回执时
 * 每 256 字节都要吃一个控制口往返，32 KiB 的粘贴就是 128 次。
 * 命令按 FIFO 排队，写入顺序即执行顺序；任一块失败整段 reject。
 */
export function pipelineSendKeys(
  commands: readonly string[][],
  execute: (command: string, timeoutMs: number | undefined) => Promise<unknown>
): Promise<void> {
  const timeoutMs = commands.length > 1 ? PIPELINED_INPUT_TIMEOUT_MS : undefined;
  return Promise.all(commands.map((argv) => execute(argv.join(' '), timeoutMs))).then(
    () => undefined
  );
}
