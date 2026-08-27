// tmux #{window_layout} 布局字符串解析
// 格式（tmux layout-custom.c）：`<4位hex校验和>,<node>`
//   node  = WxH,X,Y ( ',' paneNumId | '{' node (',' node)+ '}' | '[' node (',' node)+ ']' )
//   '{}' 为水平排列（left-right），'[]' 为垂直排列（top-bottom）
//   叶子的 paneNumId 是不带 '%' 前缀的数字，对应 tmux pane id `%<paneNumId>`

export interface TmuxLayoutLeaf {
  type: 'leaf';
  paneNumId: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface TmuxLayoutSplit {
  type: 'row' | 'column';
  width: number;
  height: number;
  x: number;
  y: number;
  children: TmuxLayoutNode[];
}

export type TmuxLayoutNode = TmuxLayoutLeaf | TmuxLayoutSplit;

export interface ParsedWindowLayout {
  checksum: string;
  root: TmuxLayoutNode;
}

export type LayoutToken =
  | { kind: 'number'; value: number }
  | { kind: 'x' }
  | { kind: 'comma' }
  | { kind: 'open-row' }
  | { kind: 'close-row' }
  | { kind: 'open-column' }
  | { kind: 'close-column' };

export interface BuiltLayoutNode {
  node: TmuxLayoutNode;
  next: number;
}

interface LayoutBounds {
  width: number;
  height: number;
  x: number;
  y: number;
  next: number;
}

const CHECKSUM_PATTERN = /^[0-9a-fA-F]{4}$/;

const SINGLE_CHAR_TOKENS: Record<string, Exclude<LayoutToken, { kind: 'number' }>> = {
  x: { kind: 'x' },
  ',': { kind: 'comma' },
  '{': { kind: 'open-row' },
  '}': { kind: 'close-row' },
  '[': { kind: 'open-column' },
  ']': { kind: 'close-column' },
};

export function tokenizeLayoutBody(input: string): LayoutToken[] | null {
  const tokens: LayoutToken[] = [];
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      const start = i;
      while (i < input.length) {
        const digit = input.charCodeAt(i);
        if (digit < 48 || digit > 57) {
          break;
        }
        i += 1;
      }
      tokens.push({ kind: 'number', value: Number.parseInt(input.slice(start, i), 10) });
      continue;
    }
    const token = SINGLE_CHAR_TOKENS[input[i]];
    if (!token) {
      return null;
    }
    tokens.push(token);
    i += 1;
  }
  return tokens;
}

function expectNumber(tokens: LayoutToken[], pos: number): { value: number; next: number } | null {
  const token = tokens[pos];
  if (token?.kind !== 'number') {
    return null;
  }
  return { value: token.value, next: pos + 1 };
}

function expectKind(tokens: LayoutToken[], pos: number, kind: LayoutToken['kind']): number | null {
  return tokens[pos]?.kind === kind ? pos + 1 : null;
}

function parseLayoutBounds(tokens: LayoutToken[], pos: number): LayoutBounds | null {
  const width = expectNumber(tokens, pos);
  if (!width) {
    return null;
  }
  const afterX = expectKind(tokens, width.next, 'x');
  if (afterX === null) {
    return null;
  }
  const height = expectNumber(tokens, afterX);
  if (!height) {
    return null;
  }
  const afterFirstComma = expectKind(tokens, height.next, 'comma');
  if (afterFirstComma === null) {
    return null;
  }
  const x = expectNumber(tokens, afterFirstComma);
  if (!x) {
    return null;
  }
  const afterSecondComma = expectKind(tokens, x.next, 'comma');
  if (afterSecondComma === null) {
    return null;
  }
  const y = expectNumber(tokens, afterSecondComma);
  if (!y) {
    return null;
  }
  return { width: width.value, height: height.value, x: x.value, y: y.value, next: y.next };
}

function parseSplitChildren(
  tokens: LayoutToken[],
  pos: number,
  closer: 'close-row' | 'close-column'
): { children: TmuxLayoutNode[]; next: number } | null {
  const children: TmuxLayoutNode[] = [];
  let cursor = pos;
  for (;;) {
    const child = buildLayoutNode(tokens, cursor);
    if (!child) {
      return null;
    }
    children.push(child.node);
    cursor = child.next;
    if (tokens[cursor]?.kind === 'comma') {
      cursor += 1;
      continue;
    }
    if (tokens[cursor]?.kind === closer) {
      return { children, next: cursor + 1 };
    }
    return null;
  }
}

export function buildLayoutNode(tokens: LayoutToken[], pos: number): BuiltLayoutNode | null {
  const bounds = parseLayoutBounds(tokens, pos);
  if (!bounds) {
    return null;
  }

  const next = tokens[bounds.next];
  if (next?.kind === 'comma') {
    const paneNumId = expectNumber(tokens, bounds.next + 1);
    if (!paneNumId) {
      return null;
    }
    return {
      node: {
        type: 'leaf',
        paneNumId: paneNumId.value,
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
      },
      next: paneNumId.next,
    };
  }

  if (next?.kind === 'open-row' || next?.kind === 'open-column') {
    const closer = next.kind === 'open-row' ? 'close-row' : 'close-column';
    const split = parseSplitChildren(tokens, bounds.next + 1, closer);
    if (!split || split.children.length < 2) {
      return null;
    }
    return {
      node: {
        type: next.kind === 'open-row' ? 'row' : 'column',
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        children: split.children,
      },
      next: split.next,
    };
  }

  return null;
}

export function parseWindowLayout(layout: string): ParsedWindowLayout | null {
  if (typeof layout !== 'string' || layout.length < 6) {
    return null;
  }
  const checksum = layout.slice(0, 4);
  if (!CHECKSUM_PATTERN.test(checksum) || layout[4] !== ',') {
    return null;
  }
  const tokens = tokenizeLayoutBody(layout.slice(5));
  if (!tokens) {
    return null;
  }
  const root = buildLayoutNode(tokens, 0);
  if (!root || root.next !== tokens.length) {
    return null;
  }
  return { checksum, root: root.node };
}

export function collectLayoutLeaves(root: TmuxLayoutNode): TmuxLayoutLeaf[] {
  const leaves: TmuxLayoutLeaf[] = [];
  const stack: TmuxLayoutNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.type === 'leaf') {
      leaves.push(node);
    } else {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        stack.push(node.children[i] as TmuxLayoutNode);
      }
    }
  }
  return leaves;
}

export function layoutLeafPaneId(leaf: TmuxLayoutLeaf): string {
  return `%${leaf.paneNumId}`;
}
