// 宽表的横向滚动壳：nodes 表（54rem）与租户表（62rem）在 1280 宽 + 侧栏展开时都摆不下，
// 「操作」列会被裁掉。macOS 的浮层滚动条平时不显形，光靠 `overflow-x-auto` 用户看不出还能滚，
// 于是这里做两件事：
//   1. 强制一条常驻的细滚动条（webkit 与 firefox 各写一套），让「还有内容」这件事看得见；
//   2. sm 以上把「操作」列钉在右边（`stickyActionColumn`）；手机宽度下固定列会吃掉大半视口，改为整行横滚。

import type { ReactNode } from 'react';

/**
 * 表格右侧常驻的动作列。表头与单元格都要带上：`bg-card` 是为了盖住滚过去的内容
 * （卡片底色即表格底色），左边一条细线把它和滚动区分开。
 */
export const stickyActionColumn =
  'sm:sticky sm:right-0 sm:z-10 sm:bg-card sm:shadow-[inset_1px_0_0_0_var(--border)]';

export function WideTableScroll({ children }: { children: ReactNode }) {
  return (
    <section className="overflow-x-auto rounded-lg border border-border/60 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar]:bg-transparent">
      {children}
    </section>
  );
}
