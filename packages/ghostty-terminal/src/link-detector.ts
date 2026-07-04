import type { SelectionLineModel } from './selection-model';

// 终端文本里的 http/https 链接：URL 内部不含空白与这些定界符。
// 故意不含 ()[]{}，避免把紧跟 URL 的右括号/方括号吞进链接。
const URL_PATTERN = /https?:\/\/[^\s"'`<>()[\]{}]+/g;
// 紧贴 URL 末尾的句读不计入链接（如 "见 https://a.com。"）。
const TRAILING_PUNCT = /[.,;:!?]+$/;

// 文件路径候选（POSIX 风格）。路径段字符排除空白、常见定界符与中文句读；
// 不支持 `~`（无法得知远端 home）。三种形态：
//   1. 绝对/显式相对：`/a/b`、`./a`、`../a/b`
//   2. 含斜杠的相对：`src/a.ts`
//   3. 裸文件名：必须带字母开头的扩展名（`main.rs`），避免把 `3.14` 之类误判
// 均可带 `:line[:col]` 后缀（计入可点区间，不参与路径解析）。
const SEG = String.raw`[^\s"'\`<>()[\]{}:,;=|/，。；：！？、（）【】《》"']`;
// lookbehind：匹配起点前不能是路径字符或斜杠，防止从 `~/work` 的 `/work` 处、
// 或更长 token 的中间开始匹配；`(?!~)` 排除 `~` 开头（无法得知远端 home）。
const FILE_PATH_PATTERN = new RegExp(
  `(?<!${SEG}|/)(?!~)(\\.{0,2}(?:/${SEG}+)+/?|${SEG}+(?:/${SEG}+)+/?|${SEG}*[^\\s"'\`<>()[\\]{}:,;=|，。；：！？、（）【】《》"'/.]\\.[A-Za-z][A-Za-z0-9]{0,9})(:\\d+(?::\\d+)?)?`,
  'g'
);

export type WrappedMatchKind = 'url' | 'file';

export interface WrappedMatch {
  kind: WrappedMatchKind;
  /** 该段所在物理行在传入 models 数组中的下标 */
  lineIndex: number;
  startCol: number;
  endCol: number;
  /** url：完整 URL；file：原始路径文本（不含 :line 后缀）。跨行时各段共享同一值 */
  text: string;
}

export interface DetectedLink {
  /** 链接起始屏幕列（含） */
  startCol: number;
  /** 链接结束屏幕列（含） */
  endCol: number;
  url: string;
}

export interface WrappedLink {
  /** 该段所在物理行在传入 models 数组中的下标 */
  lineIndex: number;
  startCol: number;
  endCol: number;
  /** 完整 URL（跨行时各段共享同一值） */
  url: string;
}

interface LineText {
  text: string;
  /** colOf[i] = text 第 i 个 UTF-16 单元所属的屏幕列；长度与 text 一致 */
  colOf: number[];
}

// 把一行的 colChars 还原成可见文本，并记录每个 UTF-16 单元对应的屏幕列。
// spacer-tail(null) 与 spacer-head('') 不产生文本；宽字符/emoji 的多个单元共享主列。
function modelToText(model: SelectionLineModel): LineText {
  let text = '';
  const colOf: number[] = [];
  const limit = model.colChars.length;
  for (let col = 0; col < limit; col += 1) {
    const ch = model.colChars[col];
    if (ch === null || ch === '') {
      continue;
    }
    for (let unit = 0; unit < ch.length; unit += 1) {
      text += ch[unit];
      colOf.push(col);
    }
  }
  return { text, colOf };
}

/** 单行链接识别，按屏幕列返回（窄/宽字符均可） */
export function detectLinksInLine(model: SelectionLineModel): DetectedLink[] {
  const { text, colOf } = modelToText(model);
  const links: DetectedLink[] = [];
  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = URL_PATTERN.exec(text);
  while (match !== null) {
    const url = match[0].replace(TRAILING_PUNCT, '');
    if (url.length > 0) {
      const startIdx = match.index;
      const endIdx = startIdx + url.length - 1;
      links.push({ startCol: colOf[startIdx], endCol: colOf[endIdx], url });
    }
    match = URL_PATTERN.exec(text);
  }
  return links;
}

/**
 * 跨软换行的链接识别：把 models 视作一条逻辑行直接拼接（软换行不插换行）后识别，
 * 再把每个链接按其跨越的物理行切成多段，映射回各自的列区间。
 */
export function detectLinksInWrappedLines(models: SelectionLineModel[]): WrappedLink[] {
  const links: WrappedLink[] = [];
  for (const match of detectMatchesInWrappedLines(models)) {
    if (match.kind === 'url') {
      links.push({
        lineIndex: match.lineIndex,
        startCol: match.startCol,
        endCol: match.endCol,
        url: match.text,
      });
    }
  }
  return links;
}

/**
 * 跨软换行的 URL + 文件路径候选识别。先识别 URL 并把其区间掩掉，再在剩余文本上
 * 识别文件路径候选（候选未经有效性校验，由调用方结合 cwd/授权根过滤）。
 * 匹配段末尾若是宽字符，endCol 扩展到其 spacer-tail 列，保证下划线/命中覆盖整个字形。
 */
export function detectMatchesInWrappedLines(models: SelectionLineModel[]): WrappedMatch[] {
  let text = '';
  const lineOf: number[] = [];
  const colOf: number[] = [];
  for (let i = 0; i < models.length; i += 1) {
    const piece = modelToText(models[i]);
    for (let k = 0; k < piece.text.length; k += 1) {
      text += piece.text[k];
      lineOf.push(i);
      colOf.push(piece.colOf[k]);
    }
  }

  const matches: WrappedMatch[] = [];
  const endColWithWideTail = (lineIndex: number, endCol: number): number => {
    const colChars = models[lineIndex]?.colChars;
    return colChars && colChars[endCol + 1] === null ? endCol + 1 : endCol;
  };
  const pushSegments = (kind: WrappedMatchKind, start: number, end: number, value: string) => {
    let segStart = start;
    for (let i = start; i <= end; i += 1) {
      const lastOfLine = i === end || lineOf[i + 1] !== lineOf[i];
      if (lastOfLine) {
        matches.push({
          kind,
          lineIndex: lineOf[segStart],
          startCol: colOf[segStart],
          endCol: endColWithWideTail(lineOf[segStart], colOf[i]),
          text: value,
        });
        segStart = i + 1;
      }
    }
  };

  const maskedChars = text.split('');
  URL_PATTERN.lastIndex = 0;
  let urlMatch: RegExpExecArray | null = URL_PATTERN.exec(text);
  while (urlMatch !== null) {
    const url = urlMatch[0].replace(TRAILING_PUNCT, '');
    if (url.length > 0) {
      const start = urlMatch.index;
      const end = start + url.length - 1;
      pushSegments('url', start, end, url);
      for (let i = start; i <= start + urlMatch[0].length - 1; i += 1) {
        maskedChars[i] = ' ';
      }
    }
    urlMatch = URL_PATTERN.exec(text);
  }

  const masked = maskedChars.join('');
  FILE_PATH_PATTERN.lastIndex = 0;
  let fileMatch: RegExpExecArray | null = FILE_PATH_PATTERN.exec(masked);
  while (fileMatch !== null) {
    const suffix = fileMatch[2] ?? '';
    let path = fileMatch[1];
    // 无 :line 后缀时剥掉紧贴末尾的句读（如 "见 src/a.ts."）；有后缀时路径以 `:` 截断，无需剥。
    if (suffix === '') {
      path = path.replace(TRAILING_PUNCT, '');
    }
    if (path.length > 0 && path !== '/') {
      const start = fileMatch.index;
      const end = start + path.length + suffix.length - 1;
      pushSegments('file', start, end, path);
    }
    fileMatch = FILE_PATH_PATTERN.exec(masked);
  }

  return matches;
}
