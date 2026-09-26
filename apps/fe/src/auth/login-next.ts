// 登录成功后的跳转目标：只接受本站路径，挡住 `?next=//evil.com`、`?next=/\evil.com`、
// `?next=https://…` 这类开放重定向。浏览器解析 URL 时会丢掉制表符与换行
// （`/\t/evil.com` 会变成 `//evil.com`），控制字符一律拒绝。

// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拦控制字符
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function sameSiteNextPath(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (raw.includes('\\') || CONTROL_CHARS.test(raw)) return '/';
  return raw;
}
