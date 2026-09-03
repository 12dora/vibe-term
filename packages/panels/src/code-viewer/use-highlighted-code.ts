import { startTransition, useEffect, useState } from 'react';
import { type HighlightClient, sharedHighlightClient } from './highlight-client';
import { planHighlight } from './language-map';

interface HighlightState {
  code: string;
  fileName: string;
  html: string | null;
}

/**
 * 高亮请求钩子：先返回 null（调用方渲染纯文本），高亮回来后再换成 HTML。
 * 结果带着请求时的 code/fileName，渲染期再比一次——迟到的回包天然作废。
 */
export function useHighlightedCode(
  code: string,
  fileName: string,
  client?: HighlightClient
): string | null {
  const [state, setState] = useState<HighlightState | null>(null);

  useEffect(() => {
    if (planHighlight(code.length, fileName).mode === 'plain') {
      return;
    }
    return (client ?? sharedHighlightClient()).request(code, fileName, (html) => {
      startTransition(() => setState({ code, fileName, html }));
    });
  }, [code, fileName, client]);

  return state?.code === code && state.fileName === fileName ? state.html : null;
}
