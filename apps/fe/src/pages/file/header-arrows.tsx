// 文本类预览（代码 / Markdown / 纯文本）的「上一个 / 下一个」：放页头，不盖正文与滚动条。

import type { FileCategory } from '@vibeterm/shared';
import type { FileRef } from '@vibeterm/stores';
import { Button } from '@vibeterm/ui/button';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { TEXT_CATEGORIES } from './preview-categories';
import { useSiblingNav } from './use-sibling-nav';

export function SiblingHeaderButtons({
  fileRef,
  category,
}: { fileRef: FileRef; category: FileCategory | undefined }) {
  const { t } = useTranslation();
  const nav = useSiblingNav(fileRef);
  const effective = category ?? nav.category;
  if (effective === null || !TEXT_CATEGORIES.has(effective)) return null;
  return (
    <>
      {nav.prev && (
        <IconTooltip label={t('file.previous')}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={nav.goPrev}
            aria-label={t('file.previous')}
            data-testid="file-prev"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </IconTooltip>
      )}
      {nav.next && (
        <IconTooltip label={t('file.next')}>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={nav.goNext}
            aria-label={t('file.next')}
            data-testid="file-next"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </IconTooltip>
      )}
    </>
  );
}
