/** `filename=` 回退值只留可打印 ASCII（非 ASCII、引号、反斜杠换成 `_`），完整名字放 `filename*=`。 */

export type DispositionType = 'inline' | 'attachment';

export function contentDisposition(name: string, type: DispositionType = 'attachment'): string {
  const ascii = name.replace(/[^\x20-\x7E]|["\\]/gu, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 去掉路径分隔、控制字符、引号；空结果视为没有文件名。 */
export function sanitizeFilename(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要去掉控制字符
  return name
    .replace(/[/\\]/g, '')
    .replace(/[\x00-\x1F\x7F"]/g, '')
    .trim();
}

/**
 * 把上游 Content-Disposition 收成可安全回给浏览器的值。
 * `forceAttachment` 时一律 `attachment`（禁止在入口源渲染活动内容），文件名本身不是活动内容。
 */
export function sanitizeContentDisposition(
  header: string | null,
  forceAttachment: boolean
): string | null {
  if (!header) return forceAttachment ? 'attachment' : null;
  const parsed = parseDisposition(header);
  const type: DispositionType =
    !forceAttachment && parsed.type === 'inline' ? 'inline' : 'attachment';
  return parsed.filename ? contentDisposition(parsed.filename, type) : type;
}

function parseDisposition(header: string): { type: string; filename: string | null } {
  const { type, params } = splitDisposition(header);
  let star: string | null = null;
  let plain: string | null = null;
  for (const [key, value] of params) {
    if (key === 'filename*') star ??= decodeFilenameStar(value);
    else if (key === 'filename') plain ??= unquoteParam(value);
  }
  const cleaned = sanitizeFilename(star ?? plain ?? '');
  return { type, filename: cleaned || null };
}

function splitDisposition(header: string): { type: string; params: Array<[string, string]> } {
  const chunks = splitUnquoted(header, ';');
  const type = (chunks[0] ?? '').trim().toLowerCase();
  const params: Array<[string, string]> = [];
  for (const chunk of chunks.slice(1)) {
    const eq = chunk.indexOf('=');
    if (eq < 0) continue;
    params.push([chunk.slice(0, eq).trim().toLowerCase(), chunk.slice(eq + 1).trim()]);
  }
  return { type, params };
}

function splitUnquoted(input: string, sep: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let inQuotes = false;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (inQuotes && ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === sep && !inQuotes) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

function decodeFilenameStar(raw: string): string | null {
  const value = unquoteParam(raw);
  const match = /^UTF-8'[^']*'(.+)$/i.exec(value);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function unquoteParam(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return raw;
}
