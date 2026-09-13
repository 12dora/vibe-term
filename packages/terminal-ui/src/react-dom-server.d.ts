// @types/react-dom 不是 @vibeterm/terminal-ui 的依赖（只有测试用 react-dom/server 跑钩子），
// 这里补最小声明；若将来把 @types/react-dom 加进本包 devDependencies，请删除本文件。
declare module 'react-dom/server' {
  import type { ReactElement } from 'react';

  export function renderToStaticMarkup(element: ReactElement): string;
}
