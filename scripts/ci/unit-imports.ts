// 廉价的相对导入扫描（正则，不解析 AST），供 workspace 跨包依赖与 gateway 目录间导入共用。
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const IMPORT_RE =
  /(?:\bfrom|\bimport|\brequire|\bmock\.module)\s*\(?\s*['"](\.{1,2}(?:\/[^'"]*)?)['"]/g;
// 测试以 `resolve(import.meta.dir, 'x.ts')` 引用同目录文件（如拉起被测入口的子进程），没有静态导入。
const DIR_REF_RE = /\b(?:resolve|join)\(\s*import\.meta\.dir\s*,\s*['"]([^'"]+)['"]\s*[,)]/g;

export function relativeImports(content: string): string[] {
  const dirRefs = [...content.matchAll(DIR_REF_RE)].map((m) =>
    m[1].startsWith('.') ? m[1] : `./${m[1]}`
  );
  return [...[...content.matchAll(IMPORT_RE)].map((m) => m[1]), ...dirRefs];
}

function walk(root: string, rel: string, out: string[]): void {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(root, path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
}

// dir（相对 root）下全部 ts/tsx 源码：路径（相对 root）→ 内容。
export function loadSources(root: string, dir: string): Map<string, string> {
  const files: string[] = [];
  walk(root, dir, files);
  return new Map(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]));
}
