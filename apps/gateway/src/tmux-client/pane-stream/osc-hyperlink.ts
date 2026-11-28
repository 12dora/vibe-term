import type { ParserContext } from './parser-state';
import {
  MAX_OSC_HYPERLINK_PARAMS_BYTES,
  MAX_OSC_HYPERLINK_URI_BYTES,
  writeByte,
  writeBytes,
  writeHyperlinkClose,
} from './parser-state';

const SEMICOLON = 0x3b;

function isWellFormedHyperlink(payload: number[]): boolean {
  const separator = payload.indexOf(SEMICOLON);
  if (separator < 0) {
    return false;
  }
  if (
    separator > MAX_OSC_HYPERLINK_PARAMS_BYTES ||
    payload.length - separator - 1 > MAX_OSC_HYPERLINK_URI_BYTES
  ) {
    return false;
  }
  // 控制字节会让重新编码出的序列在终端侧提前终止或被拼接成别的序列
  for (let index = 0; index < payload.length; index += 1) {
    const byte = payload[index] as number;
    if (byte < 0x20 || byte === 0x7f) {
      return false;
    }
  }
  return true;
}

// OSC 8 `params;uri`：合法则以 ST 终止的规范形式写回输出，否则整段丢弃（绝不转发被截断的序列）
// 并补发一个关闭序列。关闭形式 `8;;` 的 uri 为空，同样走这里。
export function forwardOscHyperlink(ctx: ParserContext): void {
  const { state } = ctx;
  if (!ctx.output) {
    return;
  }
  if (!isWellFormedHyperlink(state.oscPayloadBytes)) {
    writeHyperlinkClose(ctx.output);
    return;
  }
  writeByte(ctx.output, 0x1b);
  writeByte(ctx.output, 0x5d);
  writeByte(ctx.output, 0x38);
  writeByte(ctx.output, SEMICOLON);
  writeBytes(ctx.output, state.oscPayloadBytes);
  writeByte(ctx.output, 0x1b);
  writeByte(ctx.output, 0x5c);
}
