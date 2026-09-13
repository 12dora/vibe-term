export const DUP_WINDOW = 15;

export type DupHit = {
  fileA: string;
  lineA: number;
  fileB: string;
  lineB: number;
  lines: number;
};

export type DupAllowEntry = { a: string; b: string; reason: string };

export function tokenizeLine(raw: string): string {
  let s = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
  s = s.replace(/'(?:\\.|[^'\\])*'/g, ' STR ');
  s = s.replace(/"(?:\\.|[^"\\])*"/g, ' STR ');
  s = s.replace(/`(?:\\.|[^`])*`/g, ' STR ');
  s = s.replace(/\b0x[\da-fA-F]+\b|\b\d+\.?\d*\b/g, ' NUM ');
  return s.replace(/\s+/g, ' ').trim();
}

export function isImportish(tok: string): boolean {
  if (/^import\b/.test(tok)) return true;
  if (/^export type\b/.test(tok)) return true;
  if (/^export \*/.test(tok)) return true;
  if (/^export \{/.test(tok)) return true;
  if (/^\} from\b/.test(tok)) return true;
  return false;
}

export function isStringLiteralOnly(toks: string[]): boolean {
  return toks.every((t) => {
    const rest = t.replace(/\bSTR\b/g, '').replace(/[\s,;:|&<>()[\]{}?=*~/'"`._+\-]/g, '');
    return rest.length === 0;
  });
}

/** 文案表 / 色板 / 导出名单 / case STR 这类无语句行，单独成窗会误报。 */
export function isLowSignalLine(tok: string): boolean {
  if (isStringLiteralOnly([tok])) return true;
  if (/^[A-Za-z_][\w]*\s*:\s*(STR|NUM|true|false|null)\s*,?$/.test(tok)) return true;
  if (/^STR\s*:\s*(STR|NUM|true|false|null)\s*,?$/.test(tok)) return true;
  if (/^[A-Za-z_][\w]*\s*,$/.test(tok)) return true;
  if (/^type [A-Za-z_][\w]*\s*,$/.test(tok)) return true;
  if (/^case STR\s*:$/.test(tok)) return true;
  if (/^return (STR|NUM)\s*;?$/.test(tok)) return true;
  if (
    /^[A-Za-z_][\w]*\??\s*:\s*[A-Za-z_][\w.]*(?:\s*\|\s*(?:null|undefined|[A-Za-z_][\w.]*))*\s*;$/.test(
      tok
    )
  )
    return true;
  return false;
}

type NormLine = { n: number; tok: string };

export function normalizeFile(text: string): NormLine[] {
  const raw = text.split('\n');
  const out: NormLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const tok = tokenizeLine(raw[i] ?? '');
    if (!tok || isImportish(tok) || isLowSignalLine(tok)) continue;
    out.push({ n: i + 1, tok });
  }
  return out;
}

function hashWindow(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i * 17;
    h2 = Math.imul(h2, 16777619);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

export function dupPairKey(a: string, b: string): string {
  return a < b ? `${a}\t${b}` : `${b}\t${a}`;
}

export function isDupAllowed(hit: DupHit, allow: DupAllowEntry[]): boolean {
  return allow.some((e) => dupPairKey(e.a, e.b) === dupPairKey(hit.fileA, hit.fileB));
}

export function formatDupHit(hit: DupHit): string {
  return `${hit.fileA}:${hit.lineA} ↔ ${hit.fileB}:${hit.lineB} (${hit.lines} lines)`;
}

const BOILERPLATE_FILE_CAP = 8;

export function findDuplication(files: Array<{ rel: string; text: string }>): DupHit[] {
  const norms = files.map((f) => ({ rel: f.rel, lines: normalizeFile(f.text) }));
  const buckets = new Map<string, Array<{ fi: number; start: number }>>();

  for (let fi = 0; fi < norms.length; fi++) {
    const lines = norms[fi]?.lines ?? [];
    for (let i = 0; i + DUP_WINDOW <= lines.length; i++) {
      const slice = lines.slice(i, i + DUP_WINDOW).map((l) => l.tok);
      if (slice.every((l) => l.length < 8)) continue;
      if (isStringLiteralOnly(slice)) continue;
      const key = hashWindow(slice.join('\n'));
      const arr = buckets.get(key);
      if (arr) arr.push({ fi, start: i });
      else buckets.set(key, [{ fi, start: i }]);
    }
  }

  type Seed = { a: number; b: number; ai: number; bi: number };
  const byPair = new Map<string, Seed[]>();
  for (const locs of buckets.values()) {
    const byFile = new Map<number, number[]>();
    for (const loc of locs) {
      const arr = byFile.get(loc.fi);
      if (arr) arr.push(loc.start);
      else byFile.set(loc.fi, [loc.start]);
    }
    if (byFile.size < 2 || byFile.size > BOILERPLATE_FILE_CAP) continue;
    const ids = [...byFile.keys()].sort((x, y) => x - y);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] ?? 0;
        const b = ids[j] ?? 0;
        const aStarts = byFile.get(a) ?? [];
        const bStarts = byFile.get(b) ?? [];
        const pk = `${a}\t${b}`;
        let seeds = byPair.get(pk);
        if (!seeds) {
          seeds = [];
          byPair.set(pk, seeds);
        }
        for (const ai of aStarts) {
          for (const bi of bStarts) seeds.push({ a, b, ai, bi });
        }
      }
    }
  }

  const hits: DupHit[] = [];
  for (const seeds of byPair.values()) {
    seeds.sort((x, y) => x.ai - y.ai || x.bi - y.bi);
    const used = new Set<string>();
    for (const s of seeds) {
      const uk = `${s.ai}:${s.bi}`;
      if (used.has(uk)) continue;
      const aLines = norms[s.a]?.lines ?? [];
      const bLines = norms[s.b]?.lines ?? [];
      let len = DUP_WINDOW;
      while (
        s.ai + len < aLines.length &&
        s.bi + len < bLines.length &&
        aLines[s.ai + len]?.tok === bLines[s.bi + len]?.tok
      )
        len++;
      for (let k = 0; k < len - DUP_WINDOW + 1; k++) used.add(`${s.ai + k}:${s.bi + k}`);
      const relA = norms[s.a]?.rel ?? '';
      const relB = norms[s.b]?.rel ?? '';
      const lineA = aLines[s.ai]?.n ?? 0;
      const lineB = bLines[s.bi]?.n ?? 0;
      hits.push(
        relA < relB
          ? { fileA: relA, lineA, fileB: relB, lineB, lines: len }
          : { fileA: relB, lineA: lineB, fileB: relA, lineB: lineA, lines: len }
      );
    }
  }

  hits.sort(
    (a, b) =>
      b.lines - a.lines || a.fileA.localeCompare(b.fileA) || a.lineA - b.lineA || a.lineB - b.lineB
  );
  const kept: DupHit[] = [];
  for (const h of hits) {
    const overlap = kept.some((k) => samePair(k, h) && rangesOverlap(k, h));
    if (!overlap) kept.push(h);
  }
  kept.sort(
    (a, b) => a.fileA.localeCompare(b.fileA) || a.fileB.localeCompare(b.fileB) || a.lineA - b.lineA
  );
  return kept;
}

function samePair(a: DupHit, b: DupHit): boolean {
  return a.fileA === b.fileA && a.fileB === b.fileB;
}

function rangesOverlap(a: DupHit, b: DupHit): boolean {
  const overA = a.lineA < b.lineA + b.lines && b.lineA < a.lineA + a.lines;
  const overB = a.lineB < b.lineB + b.lines && b.lineB < a.lineB + a.lines;
  return overA && overB;
}
