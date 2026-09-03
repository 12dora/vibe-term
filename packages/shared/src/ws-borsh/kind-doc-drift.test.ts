import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as kindModule from './kind';

const SPEC_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'docs',
  'ws-protocol',
  '2026021402-ws-borsh-v1-spec.md'
);

const KIND_TABLE_HEADING = '## kind 编号表（完整）';
const ROW_RE = /^\|\s*(0x[0-9A-F]{4})\s*\|\s*([A-Z][A-Z0-9_]*)\s*\|\s*(C2S|S2C|BIDI)\s*\|.*\|$/;

function formatKind(kind: number): string {
  return `0x${kind.toString(16).toUpperCase().padStart(4, '0')}`;
}

function readCodeKinds(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const [exportName, value] of Object.entries(kindModule)) {
    if (!exportName.startsWith('KIND_') || typeof value !== 'number') continue;
    entries.set(formatKind(value), exportName.slice('KIND_'.length));
  }
  return entries;
}

function readDocKinds(): Map<string, string> {
  const markdown = readFileSync(SPEC_PATH, 'utf8');
  const start = markdown.indexOf(KIND_TABLE_HEADING);
  if (start < 0) throw new Error(`spec 缺少「${KIND_TABLE_HEADING}」小节：${SPEC_PATH}`);
  const rest = markdown.slice(start + KIND_TABLE_HEADING.length);
  const end = rest.indexOf('\n## ');
  const section = end < 0 ? rest : rest.slice(0, end);

  const entries = new Map<string, string>();
  for (const line of section.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.includes('0x')) continue;
    const matched = ROW_RE.exec(trimmed);
    if (!matched) throw new Error(`kind 表存在无法解析的行：${trimmed}`);
    const [, hex, name] = matched as unknown as [string, string, string];
    const duplicated = entries.get(hex);
    if (duplicated) throw new Error(`kind 表重复登记 ${hex}：${duplicated} / ${name}`);
    entries.set(hex, name);
  }
  return entries;
}

function describeDiff(label: string, hexes: string[], source: Map<string, string>): string {
  if (hexes.length === 0) return '';
  const items = hexes.map((hex) => `${hex} ${source.get(hex)}`).join(', ');
  return `${label}: ${items}`;
}

describe('kind 注册表与 ws-borsh 规范文档一致', () => {
  test('kind 编号表覆盖 kind.ts 的全部 KIND_* 且无多余项', () => {
    const code = readCodeKinds();
    const doc = readDocKinds();

    const missingInDoc = [...code.keys()].filter((hex) => !doc.has(hex)).sort();
    const extraInDoc = [...doc.keys()].filter((hex) => !code.has(hex)).sort();
    const renamed = [...code.entries()]
      .filter(([hex, name]) => doc.has(hex) && doc.get(hex) !== name)
      .map(([hex, name]) => `${hex} 代码为 ${name}，文档为 ${doc.get(hex)}`);

    const problems = [
      describeDiff('文档缺少', missingInDoc, code),
      describeDiff('文档多出', extraInDoc, doc),
      renamed.length > 0 ? `名称不一致: ${renamed.join(', ')}` : '',
    ].filter(Boolean);

    expect(problems.join('; ')).toBe('');
    expect(doc.size).toBe(code.size);
  });

  test('文档登记的 kind 全部通过 isValidKind', () => {
    for (const hex of readDocKinds().keys()) {
      expect(kindModule.isValidKind(Number.parseInt(hex, 16))).toBe(true);
    }
  });
});
