// 登录记录「设备」列：把 User-Agent 压成「Chrome · macOS」这样的一小段。
// 只认常见的浏览器 / 系统；认不出的部分省略，整段都认不出时回 `null`，原文留给 tooltip。

const BROWSERS: Array<[RegExp, string]> = [
  [/vibeterm/i, 'VibeTerm CLI'],
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\b(?:OPR|Opera)\//, 'Opera'],
  [/\b(?:Firefox|FxiOS)\//, 'Firefox'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bCriOS\//, 'Chrome'],
  [/\bChrom(?:e|ium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
  [/\bBun\//, 'Bun'],
  [/\bcurl\//, 'curl'],
  [/\bnode-fetch\b|\bundici\b|\bNode\.js\b/i, 'Node.js'],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\b(?:Windows|win32)\b/i, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\b(?:Macintosh|Mac OS X|darwin)\b/i, 'macOS'],
  [/\blinux\b/i, 'Linux'],
];

function firstMatch(ua: string, table: Array<[RegExp, string]>): string | null {
  for (const [pattern, label] of table) if (pattern.test(ua)) return label;
  return null;
}

export function userAgentSummary(ua: string | null | undefined): string | null {
  const text = ua?.trim();
  if (!text) return null;
  const parts = [firstMatch(text, BROWSERS), firstMatch(text, SYSTEMS)].filter(
    (part): part is string => part !== null
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}
