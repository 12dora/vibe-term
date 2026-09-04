export type ParseCommandError = 'empty' | 'invalid';

export type ParseCommandResult =
  | {
      ok: true;
      name: string;
      args: string[];
      nodeTarget?: string;
      tail?: string;
    }
  | { ok: false; error: ParseCommandError };

function isSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function chAt(input: string, index: number): string {
  return input.slice(index, index + 1);
}

function readQuoted(input: string, start: number): { token: string; next: number } {
  const quote = chAt(input, start);
  let i = start + 1;
  let out = '';
  while (i < input.length) {
    const ch = chAt(input, i);
    if (ch === '\\' && i + 1 < input.length) {
      out += chAt(input, i + 1);
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { token: out, next: i + 1 };
    }
    out += ch;
    i += 1;
  }
  return { token: out, next: i };
}

export interface TokenSpan {
  value: string;
  start: number;
  end: number;
}

export function tokenizeSpans(input: string): TokenSpan[] {
  const tokens: TokenSpan[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && isSpace(chAt(input, i))) i += 1;
    if (i >= input.length) break;
    const start = i;
    const ch = chAt(input, i);
    if (ch === '"' || ch === "'") {
      const quoted = readQuoted(input, i);
      tokens.push({ value: quoted.token, start, end: quoted.next });
      i = quoted.next;
      continue;
    }
    let j = i;
    while (j < input.length && !isSpace(chAt(input, j))) j += 1;
    tokens.push({ value: input.slice(i, j), start, end: j });
    i = j;
  }
  return tokens;
}

export function tokenize(input: string): string[] {
  return tokenizeSpans(input).map((token) => token.value);
}

function stripLeadingSlash(raw: string): string {
  return raw.startsWith('/') ? raw.slice(1) : raw;
}

function commandNameFromToken(token: string): string {
  const at = token.indexOf('@');
  const name = at === -1 ? token : token.slice(0, at);
  return name.trim().toLowerCase();
}

function isAtNodeToken(token: string): boolean {
  return token.startsWith('@') && token.length > 1 && !token.startsWith('@@');
}

export function parseCommand(rawText: string): ParseCommandResult {
  const trimmed = rawText.trim();
  if (!trimmed) return { ok: false, error: 'empty' };
  const body = stripLeadingSlash(trimmed).trim();
  if (!body) return { ok: false, error: 'empty' };

  const tokens = tokenizeSpans(body);
  const first = tokens[0];
  if (!first) return { ok: false, error: 'empty' };

  const name = commandNameFromToken(first.value);
  if (!name) return { ok: false, error: 'invalid' };

  const args: string[] = [];
  let nodeTarget: string | undefined;
  let tail: string | undefined;
  let positionalStarted = false;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) break;
    if (token.value === '--') {
      tail = body.slice(token.end).trim();
      break;
    }
    if (token.value === '--node') {
      const next = tokens[i + 1];
      if (next === undefined || next.value === '--') {
        return { ok: false, error: 'invalid' };
      }
      nodeTarget = next.value;
      i += 1;
      continue;
    }
    if (!positionalStarted && isAtNodeToken(token.value)) {
      nodeTarget = token.value.slice(1);
      continue;
    }
    positionalStarted = true;
    args.push(token.value);
  }

  return { ok: true, name, args, nodeTarget, tail };
}
