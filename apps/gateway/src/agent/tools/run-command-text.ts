// ANSI/OSC/CSI 控制序列，必须匹配字面 ESC/BEL/BS。
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control bytes
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control bytes
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control bytes
const CHARSET_RE = /\x1b[()][AB0-9]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control bytes
const TWO_BYTE_ESC_RE = /\x1b[=>NOcDEHM]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal control bytes
const BACKSPACE_RE = /.\x08/g;

export function cleanTerminalText(raw: string): string {
  let text = raw
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(CHARSET_RE, '')
    .replace(TWO_BYTE_ESC_RE, '')
    .replace(BACKSPACE_RE, '');
  text = text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) {
        return line.replace(/\s+$/, '');
      }
      const segs = line.split('\r').filter((s) => s.length > 0);
      return (segs[segs.length - 1] ?? '').replace(/\s+$/, '');
    })
    .join('\n');
  return text;
}

export function lastNonEmptyLine(text: string): string {
  const lines = cleanTerminalText(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim().length > 0) {
      return lines[i];
    }
  }
  return '';
}

export function buildPromptRegex(promptLine: string): RegExp | null {
  const trimmed = promptLine.trim();
  if (!trimmed) {
    return null;
  }
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*$`);
}
