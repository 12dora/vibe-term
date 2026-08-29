// 「复制」按钮的共享部件：复制状态 + 可访问的反馈。
//
// 播报区里**只能**放「已复制」：把可见标签整段塞进 live region 的话，2 秒后复位会让
// 「复制」变成一条新内容再播一次，读屏用户听到的是一句莫名其妙的第二次提示。
// 可见标签因此留在 live region 外面。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const COPIED_RESET_MS = 2000;

export interface CopyToClipboard {
  copied: boolean;
  copy: () => void;
}

export function useCopyToClipboard(value: string): CopyToClipboard {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    []
  );

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    });
  }, [value]);

  return { copied, copy };
}

/** 按钮里的可见标签 + 常驻的 sr-only 播报节点。 */
export function CopyLabel({ copied }: { copied: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <span>{copied ? t('nodes.actions.copied') : t('nodes.actions.copy')}</span>
      <output className="sr-only" aria-live="polite">
        {copied ? t('nodes.actions.copied') : ''}
      </output>
    </>
  );
}
