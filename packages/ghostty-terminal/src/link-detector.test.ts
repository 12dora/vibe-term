import { describe, expect, test } from 'bun:test';
import {
  detectLinksInLine,
  detectLinksInWrappedLines,
  detectMatchesInWrappedLines,
} from './link-detector';
import { type SelectionLineModel, lineModelFromText } from './selection-model';

function model(colChars: (string | null)[], wrappedToNext = false): SelectionLineModel {
  let contentCols = 0;
  for (let i = colChars.length - 1; i >= 0; i -= 1) {
    const ch = colChars[i];
    if (ch !== null && ch !== '' && ch !== ' ') {
      contentCols = i + 1;
      break;
    }
  }
  return { colChars, contentCols, wrappedToNext };
}

describe('detectLinksInLine', () => {
  test('识别行内 https 链接并定位列区间', () => {
    const line = lineModelFromText('see https://example.com now');
    const links = detectLinksInLine(line);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('https://example.com');
    expect(links[0].startCol).toBe(4); // 's'=0..'see '=4
    expect(links[0].endCol).toBe(4 + 'https://example.com'.length - 1);
  });

  test('识别 http 与带路径/查询串的链接', () => {
    const line = lineModelFromText('http://a.io/p?x=1&y=2#f');
    const links = detectLinksInLine(line);
    expect(links).toHaveLength(1);
    expect(links[0].url).toBe('http://a.io/p?x=1&y=2#f');
    expect(links[0].startCol).toBe(0);
  });

  test('裁剪 URL 末尾句读', () => {
    const line = lineModelFromText('go https://example.com.');
    const [link] = detectLinksInLine(line);
    expect(link.url).toBe('https://example.com');
  });

  test('一行多个链接', () => {
    const line = lineModelFromText('https://a.com https://b.com');
    const links = detectLinksInLine(line);
    expect(links.map((l) => l.url)).toEqual(['https://a.com', 'https://b.com']);
  });

  test('无链接返回空数组', () => {
    expect(detectLinksInLine(lineModelFromText('just plain text, no url'))).toEqual([]);
    expect(detectLinksInLine(lineModelFromText('ftp://nope.com /etc/hosts'))).toEqual([]);
  });

  test('宽字符在前时列区间仍正确（spacer-tail 占列）', () => {
    // '你' 占两列：主列 + spacer-tail(null)，随后是 URL
    const colChars: (string | null)[] = ['你', null, ...Array.from('https://x.io')];
    const [link] = detectLinksInLine(model(colChars));
    expect(link.url).toBe('https://x.io');
    expect(link.startCol).toBe(2); // 宽字符占 0、1 两列，URL 从第 2 列开始
  });
});

describe('detectLinksInWrappedLines', () => {
  test('跨软换行的链接被识别并按物理行切段', () => {
    // 第一行软换行到第二行，URL 被换行边界切断
    const first = model(Array.from('go https://example.com/very'), true);
    const second = model(Array.from('/long/path?a=1'), false);
    const links = detectLinksInWrappedLines([first, second]);
    expect(links.length).toBe(2);
    expect(links[0].url).toBe('https://example.com/very/long/path?a=1');
    expect(links[1].url).toBe('https://example.com/very/long/path?a=1');
    expect(links[0].lineIndex).toBe(0);
    expect(links[1].lineIndex).toBe(1);
    expect(links[0].startCol).toBe(3); // 'go ' 之后
    expect(links[1].startCol).toBe(0); // 第二行从行首开始
  });

  test('单行情形与 detectLinksInLine 等价', () => {
    const only = lineModelFromText('x https://a.com y');
    const wrapped = detectLinksInWrappedLines([only]);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].lineIndex).toBe(0);
    expect(wrapped[0].url).toBe('https://a.com');
  });
});

describe('detectMatchesInWrappedLines - 文件路径候选', () => {
  const detect = (text: string) => detectMatchesInWrappedLines([lineModelFromText(text)]);
  const files = (text: string) =>
    detect(text)
      .filter((m) => m.kind === 'file')
      .map((m) => m.text);

  test('绝对路径', () => {
    expect(files('cat /etc/hosts now')).toEqual(['/etc/hosts']);
  });

  test('显式相对路径 ./ 与 ../', () => {
    expect(files('vi ./src/main.ts and ../lib/a.c')).toEqual(['./src/main.ts', '../lib/a.c']);
  });

  test('含斜杠的相对路径', () => {
    expect(files('open src/utils/fileUrl.ts')).toEqual(['src/utils/fileUrl.ts']);
  });

  test('裸文件名需要字母开头的扩展名', () => {
    expect(files('build main.rs done')).toEqual(['main.rs']);
    expect(files('pi is 3.14 ok')).toEqual([]);
  });

  test(':line 与 :line:col 后缀计入区间但不计入路径', () => {
    const [match] = detect('src/a.ts:12:5 error');
    expect(match.kind).toBe('file');
    expect(match.text).toBe('src/a.ts');
    expect(match.startCol).toBe(0);
    expect(match.endCol).toBe('src/a.ts:12:5'.length - 1);
  });

  test('URL 区间被掩掉，不会重复识别为文件路径', () => {
    const matches = detect('see https://example.com/a/b.ts now');
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe('url');
  });

  test('URL 与文件路径可同行共存', () => {
    const matches = detect('doc https://a.com and /var/log/app.log');
    expect(matches.map((m) => m.kind)).toEqual(['url', 'file']);
    expect(matches[1].text).toBe('/var/log/app.log');
  });

  test('剥掉紧贴末尾的句读', () => {
    expect(files('见 src/a.ts.')).toEqual(['src/a.ts']);
  });

  test('引号/括号是定界符', () => {
    expect(files('open "/tmp/x.log" (see ./a/b)')).toEqual(['/tmp/x.log', './a/b']);
  });

  test('不识别 ~ 前缀与纯斜杠', () => {
    expect(files('cd ~/work now / alone')).toEqual([]);
  });

  test('宽字符文件名 endCol 覆盖 spacer-tail 列', () => {
    // '/日志.txt'：'日' 与 '志' 各占两列
    const colChars: (string | null)[] = ['/', '日', null, '志', null, ...Array.from('.txt')];
    const [match] = detectMatchesInWrappedLines([
      { colChars, contentCols: colChars.length, wrappedToNext: false },
    ]);
    expect(match.kind).toBe('file');
    expect(match.text).toBe('/日志.txt');
    expect(match.startCol).toBe(0);
    expect(match.endCol).toBe(colChars.length - 1);
  });

  test('跨软换行的文件路径按物理行切段', () => {
    const first = model(Array.from('ls /usr/local/sha'), true);
    const second = model(Array.from('re/doc/readme.md'), false);
    const matches = detectMatchesInWrappedLines([first, second]);
    expect(matches).toHaveLength(2);
    expect(matches[0].text).toBe('/usr/local/share/doc/readme.md');
    expect(matches[0].lineIndex).toBe(0);
    expect(matches[1].lineIndex).toBe(1);
    expect(matches[1].startCol).toBe(0);
  });
});
