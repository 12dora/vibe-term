// 用户文件字节回给浏览器时的类型、处置与 CSP。本机 file-serve 与 mesh 转发的上游响应共用这一份规则，
// 保证同一个文件经本机或经 `/n/<id>` 访问时浏览器行为一致。
//
// 只有白名单类型可以 inline；其余一律 `application/octet-stream` + attachment，绝不在入口源渲染
// HTML / XML 这类可执行文档。SVG 例外：浏览器以图片目的地（`Sec-Fetch-Dest: image`，即 `<img>` / CSS）
// 拉取时脚本不会执行，按 `image/svg+xml` 回；直接导航打开时按附件下载。

import { sanitizeContentDisposition } from '../api/content-disposition';

export const FILE_RESPONSE_CSP =
  "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export const INLINE_FILE_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'text/plain',
  'application/json',
  'application/x-ndjson',
  'application/pdf',
  'application/octet-stream',
]);

const SVG_MIME = 'image/svg+xml';
const OCTET_STREAM = 'application/octet-stream';

export function baseMime(contentType: string | null | undefined): string {
  return (contentType ?? '').trim().toLowerCase().split(';')[0]?.trim() ?? '';
}

function isImageDestination(req: Request): boolean {
  return req.headers.get('sec-fetch-dest')?.toLowerCase() === 'image';
}

export type SafeFileHeaderInput = {
  contentType: string | null;
  disposition: string | null;
  /** 浏览器发给本机的那个请求（转发场景是入口收到的请求，不是上游请求）。 */
  req: Request;
};

export function applySafeFileHeaders(headers: Headers, input: SafeFileHeaderInput): void {
  const mime = baseMime(input.contentType);
  const inline = INLINE_FILE_MIME.has(mime) || (mime === SVG_MIME && isImageDestination(input.req));
  headers.set('content-type', inline ? input.contentType?.trim() || mime : OCTET_STREAM);
  const disposition = sanitizeContentDisposition(input.disposition, !inline);
  if (disposition) headers.set('content-disposition', disposition);
  else headers.delete('content-disposition');
  headers.set('content-security-policy', FILE_RESPONSE_CSP);
  headers.set('x-content-type-options', 'nosniff');
  if (mime === SVG_MIME) headers.append('vary', 'Sec-Fetch-Dest');
}
