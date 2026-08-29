import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import {
  SIDE_PANEL_PARAM,
  type SidePanelName,
  nextSidePanelParams,
  parseSidePanel,
  sidePanelHref,
} from './side-panel-url';

export interface SidePanelApi {
  /** 当前打开的面板；没有或参数非法时为 null。 */
  panel: SidePanelName | null;
  /** 打开走 push：移动端的返回键因此能直接关掉面板。 */
  open: (name: SidePanelName) => void;
  /** 关闭走 replace：反复开关不会把历史撑满。 */
  close: () => void;
  /** 入口链接的 `to`，只含查询串（pathname 由 react-router 补当前页）。 */
  hrefFor: (name: SidePanelName) => string;
}

export function useSidePanel(): SidePanelApi {
  const [searchParams, setSearchParams] = useSearchParams();
  const panel = parseSidePanel(searchParams.get(SIDE_PANEL_PARAM));

  const open = useCallback(
    (name: SidePanelName) => {
      setSearchParams((current) => nextSidePanelParams(current, name));
    },
    [setSearchParams]
  );

  const close = useCallback(() => {
    setSearchParams((current) => nextSidePanelParams(current, null), { replace: true });
  }, [setSearchParams]);

  const hrefFor = useCallback(
    (name: SidePanelName) => sidePanelHref(searchParams, name),
    [searchParams]
  );

  return { panel, open, close, hrefFor };
}
