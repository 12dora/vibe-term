// 公开仓库敏感内容门禁：安全审计材料、漏洞编号与复现步骤不得入库。
// 仓库只保留使用与行为文档；审计材料放在仓库之外。`bun run lint` 调用。

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export type SensitiveHit = { path: string; line: number; rule: string; text: string };

const PATH_RULE =
  /(^|\/)(audit|audits|pen[t]est|pen-test|security-audit|vuln|vulns|p[o]c|p[o]cs|exploits?|findings)([/._-]|$)/i;

const CONTENT_RULES: ReadonlyArray<{ rule: string; re: RegExp }> = [
  {
    rule: 'finding-id',
    re: /\b(?:A-[0-9]{2}|B-[HML][0-9]|BB-[0-9]|CR[0-9]-[0-9]{1,2}|DW-?[0-9]|D-[0-9]{1,2}|E-[0-9])\b/,
  },
  {
    rule: 'finding-id',
    re: /[（(]C(?:[1-9]|1[0-9])[）),，]|\bC(?:[1-9]|1[0-9])[:：]|\b(?:WP[0-9]{1,2}[a-z]?|REFAC[0-9]|FIX-[A-Z][A-Z0-9]*)\b/,
  },
  {
    rule: 'audit-wording',
    re: /\bPoC\b|proof[- ]of[- ]concept|\u6e17\u900f\u6d4b\u8bd5|\u5ba1\u8ba1\u62a5\u544a|audit[ ]report|pen[t]est|\u6f0f\u6d1e\u590d\u73b0|\u653b\u51fb\u94fe|exploit[ ]chain|exploi[t]ation/i,
  },
];

const SKIPPED_PATHS: ReadonlyArray<RegExp> = [
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)LICENSE(\.[a-z]+)?$/i,
  /\.lock$/,
  /\.(png|jpe?g|gif|webp|ico|wasm|woff2?|ttf|otf|gz|br|zip|tgz|pdf)$/i,
  /^packages\/shared\/src\/i18n\/(resources|types)\.ts$/,
  /^packages\/shared\/src\/i18n\/locales\/generated\//,
  /^scripts\/ci\/sensitive-content(\.test)?\.ts$/,
];

export function scanSensitive(path: string, text: string): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  if (PATH_RULE.test(path)) hits.push({ path, line: 0, rule: 'path', text: path });
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    for (const { rule, re } of CONTENT_RULES) {
      const match = re.exec(line);
      if (match) hits.push({ path, line: i + 1, rule, text: match[0] });
    }
  }
  return hits;
}

export function isSkippedPath(path: string): boolean {
  return SKIPPED_PATHS.some((re) => re.test(path));
}

function trackedFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
    }
  );
  return out.split('\0').filter(Boolean);
}

function main(): void {
  const hits: SensitiveHit[] = [];
  for (const path of trackedFiles()) {
    if (isSkippedPath(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    hits.push(...scanSensitive(path, text));
  }
  if (hits.length === 0) {
    console.log('sensitive-content gate ok');
    return;
  }
  for (const hit of hits.slice(0, 50)) {
    console.error(`sensitive-content: ${hit.path}:${hit.line} [${hit.rule}] ${hit.text}`);
  }
  console.error(
    `sensitive-content gate failed: ${hits.length} hit(s). 安全审计材料、漏洞编号与复现步骤不得入库；文档只写当前行为与配置。`
  );
  process.exit(1);
}

if (import.meta.main) main();
