import ts from 'typescript';

export const LIMITS = { cc: 12, fnLines: 80, fileLines: 500, params: 5, nesting: 4 } as const;
export const FILE_WARN_LINES = 450;
export const FROZEN_REASON = 'round46 收紧门禁时冻结的存量';

export type FnMetrics = {
  file: string;
  name: string;
  line: number;
  cc: number;
  lines: number;
  params: number;
  nesting: number;
};

export type AllowEntry = {
  cc?: number;
  lines?: number;
  fileLines?: number;
  params?: number;
  nesting?: number;
  reason: string;
};

export type AllowMap = Record<string, AllowEntry>;

export function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  );
}

export function functionName(n: ts.Node): string | null {
  if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n))
    return n.name?.getText() ?? '<anon>';
  if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.parent) {
    if (ts.isVariableDeclaration(n.parent)) return n.parent.name.getText();
    if (ts.isPropertyAssignment(n.parent)) return n.parent.name.getText();
    if (n.body && ts.isBlock(n.body) && n.body.statements.length > 15) return '<anon>';
  }
  return null;
}

export function cyclomatic(fn: ts.Node): number {
  let cc = 1;
  const visit = (n: ts.Node): void => {
    if (n !== fn && isFunctionLike(n)) return;
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ConditionalExpression:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CatchClause:
        cc++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const op = (n as ts.BinaryExpression).operatorToken.kind;
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        )
          cc++;
        break;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return cc;
}

export function paramCount(n: ts.Node): number {
  if (!isFunctionLike(n)) return 0;
  return n.parameters.filter((p) => p.name.getText() !== 'this').length;
}

function isElseIf(n: ts.IfStatement): boolean {
  return ts.isIfStatement(n.parent) && n.parent.elseStatement === n;
}

function isControlNesting(n: ts.Node): boolean {
  switch (n.kind) {
    case ts.SyntaxKind.IfStatement:
      return !isElseIf(n as ts.IfStatement);
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.SwitchStatement:
    case ts.SyntaxKind.TryStatement:
      return true;
    default:
      return false;
  }
}

function hasBlockBody(n: ts.Node): boolean {
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return ts.isBlock(n.body);
  return false;
}

/** 只计 if/for/while/switch/try 与匿名箭头回调块，不计裸 Block，else-if 不加层。 */
export function maxNesting(fn: ts.Node): number {
  let max = 0;
  const visit = (n: ts.Node, depth: number): void => {
    if (n !== fn && isFunctionLike(n)) {
      if (functionName(n) !== null) return;
      const next = hasBlockBody(n) ? depth + 1 : depth;
      if (next > max) max = next;
      ts.forEachChild(n, (c) => visit(c, next));
      return;
    }
    let next = depth;
    if (isControlNesting(n)) {
      next = depth + 1;
      if (next > max) max = next;
    }
    ts.forEachChild(n, (c) => visit(c, next));
  };
  visit(fn, 0);
  return max;
}

export function analyzeSource(text: string, rel: string): { fns: FnMetrics[]; lines: number } {
  const sf = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const fns: FnMetrics[] = [];
  const visit = (n: ts.Node): void => {
    const name = isFunctionLike(n) ? functionName(n) : null;
    if (name !== null) {
      const start = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1;
      fns.push({
        file: rel,
        name,
        line: start,
        cc: cyclomatic(n),
        lines: end - start + 1,
        params: paramCount(n),
        nesting: maxNesting(n),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { fns, lines: text.split('\n').length };
}

export function fnKey(file: string, name: string): string {
  return `${file}:${name}`;
}

function freezeField(
  measured: number,
  existing: number | undefined,
  limit: number
): number | undefined {
  if (measured <= limit) return undefined;
  if (existing === undefined) return measured;
  return Math.min(existing, measured);
}

export function tightenAllowlist(
  allow: AllowMap,
  fns: FnMetrics[],
  fileLineCounts: Map<string, number>
): AllowMap {
  const maxCc = new Map<string, number>();
  const maxLines = new Map<string, number>();
  const maxParams = new Map<string, number>();
  const maxNestingByKey = new Map<string, number>();
  for (const fn of fns) {
    const key = fnKey(fn.file, fn.name);
    maxCc.set(key, Math.max(maxCc.get(key) ?? 0, fn.cc));
    maxLines.set(key, Math.max(maxLines.get(key) ?? 0, fn.lines));
    maxParams.set(key, Math.max(maxParams.get(key) ?? 0, fn.params));
    maxNestingByKey.set(key, Math.max(maxNestingByKey.get(key) ?? 0, fn.nesting));
  }

  const next: AllowMap = {};
  const keep = (key: string, entry: AllowEntry, fields: Omit<AllowEntry, 'reason'>): void => {
    const cc = fields.cc;
    const lines = fields.lines;
    const fileLines = fields.fileLines;
    const params = fields.params;
    const nesting = fields.nesting;
    if (
      cc === undefined &&
      lines === undefined &&
      fileLines === undefined &&
      params === undefined &&
      nesting === undefined
    )
      return;
    const updated: AllowEntry = { reason: entry.reason };
    if (cc !== undefined) updated.cc = cc;
    if (lines !== undefined) updated.lines = lines;
    if (fileLines !== undefined) updated.fileLines = fileLines;
    if (params !== undefined) updated.params = params;
    if (nesting !== undefined) updated.nesting = nesting;
    next[key] = updated;
  };

  for (const [key, entry] of Object.entries(allow)) {
    if (fileLineCounts.has(key)) {
      keep(key, entry, {
        fileLines: freezeField(fileLineCounts.get(key) ?? 0, entry.fileLines, LIMITS.fileLines),
      });
      continue;
    }
    if (!maxCc.has(key) && !maxLines.has(key)) continue;
    keep(key, entry, {
      cc: freezeField(maxCc.get(key) ?? 0, entry.cc, LIMITS.cc),
      lines: freezeField(maxLines.get(key) ?? 0, entry.lines, LIMITS.fnLines),
      params: freezeField(maxParams.get(key) ?? 0, entry.params, LIMITS.params),
      nesting: freezeField(maxNestingByKey.get(key) ?? 0, entry.nesting, LIMITS.nesting),
    });
  }

  for (const [file, lines] of fileLineCounts) {
    if (lines <= LIMITS.fileLines) continue;
    if (next[file]) continue;
    const prev = allow[file];
    keep(file, prev ?? { reason: FROZEN_REASON }, {
      fileLines: freezeField(lines, prev?.fileLines, LIMITS.fileLines),
    });
  }

  for (const fn of fns) {
    const key = fnKey(fn.file, fn.name);
    if (next[key]) continue;
    const cc = maxCc.get(key) ?? 0;
    const lines = maxLines.get(key) ?? 0;
    const params = maxParams.get(key) ?? 0;
    const nesting = maxNestingByKey.get(key) ?? 0;
    if (
      cc <= LIMITS.cc &&
      lines <= LIMITS.fnLines &&
      params <= LIMITS.params &&
      nesting <= LIMITS.nesting
    )
      continue;
    const prev = allow[key];
    keep(key, prev ?? { reason: FROZEN_REASON }, {
      cc: freezeField(cc, prev?.cc, LIMITS.cc),
      lines: freezeField(lines, prev?.lines, LIMITS.fnLines),
      params: freezeField(params, prev?.params, LIMITS.params),
      nesting: freezeField(nesting, prev?.nesting, LIMITS.nesting),
    });
  }

  return next;
}
