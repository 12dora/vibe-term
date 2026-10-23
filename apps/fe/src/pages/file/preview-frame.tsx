// 预览区外框：常驻不卸载（切换文件时 stat 加载 / 失败都留在框内），只换里面的内容。
// 图片 / PDF / 音视频在查看器左右边缘叠加「上一个 / 下一个」圆形按钮并接管方向键；
// 文本类的切换按钮在页头（SiblingHeaderButtons）。没有对应兄弟时对应按钮不渲染，不循环。

import type { FileCategory } from '@vibeterm/shared';
import type { FileRef } from '@vibeterm/stores';
import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MEDIA_CATEGORIES } from './preview-categories';
import { type SiblingNav, useSiblingArrowKeys, useSiblingNav } from './use-sibling-nav';

// 桌面端悬停 / 聚焦才显现，触屏常驻（触屏没有悬停）。
const ARROW_BUTTON_CLASS =
  'absolute top-1/2 z-10 -translate-y-1/2 rounded-full border bg-background/70 shadow-sm backdrop-blur-sm transition-opacity hover:bg-background/90 opacity-0 group-hover/preview:opacity-100 group-focus-within/preview:opacity-100 focus-visible:opacity-100 [@media(any-pointer:coarse)]:opacity-100';

function ArrowButton({
  side,
  label,
  onClick,
}: { side: 'left' | 'right'; label: string; onClick(): void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={side === 'left' ? 'file-prev' : 'file-next'}
      className={cn(ARROW_BUTTON_CLASS, side === 'left' ? 'left-3' : 'right-3')}
    >
      <Icon className="h-5 w-5" />
    </Button>
  );
}

function SiblingArrows({ nav }: { nav: SiblingNav }) {
  const { t } = useTranslation();
  return (
    <>
      {nav.prev && <ArrowButton side="left" label={t('file.previous')} onClick={nav.goPrev} />}
      {nav.next && <ArrowButton side="right" label={t('file.next')} onClick={nav.goNext} />}
    </>
  );
}

/** `category` 是 stat 给出的类别；stat 未就绪时退回列表里的条目类别。 */
export function PreviewFrame({
  fileRef,
  category,
  children,
}: { fileRef: FileRef; category: FileCategory | undefined; children: ReactNode }) {
  const nav = useSiblingNav(fileRef);
  const effective = category ?? nav.category;
  useSiblingArrowKeys(nav, effective);
  return (
    <div className="group/preview relative h-full">
      {children}
      {effective !== null && MEDIA_CATEGORIES.has(effective) && <SiblingArrows nav={nav} />}
    </div>
  );
}
