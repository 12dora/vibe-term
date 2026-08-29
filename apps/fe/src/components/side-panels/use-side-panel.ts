import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import {
  SIDE_PANEL_PARAM,
  type SidePanelName,
  nextSidePanelParams,
  parseSidePanel,
  sidePanelHref,
} from './side-panel-url';

/** 由应用内入口打开的面板在 history state 上打标，关闭时才能确定该回退一条历史而不是 replace。 */
export const SIDE_PANEL_LINK_STATE = { sidePanelPushed: true } as const;

function pushedByApp(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    (state as { sidePanelPushed?: unknown }).sidePanelPushed === true
  );
}

export interface SidePanelApi {
  /** 当前打开的面板；没有或参数非法时为 null。 */
  panel: SidePanelName | null;
  /** 打开走 push：移动端的返回键因此能直接关掉面板。 */
  open: (name: SidePanelName) => void;
  /** 关闭：应用内 push 打开的回退一条历史（不堆重复条目）；深链直达的则 replace 掉参数。 */
  close: () => void;
  /** 入口链接的 `to`，只含查询串（pathname 由 react-router 补当前页）。 */
  hrefFor: (name: SidePanelName) => string;
}

export function useSidePanel(): SidePanelApi {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const panel = parseSidePanel(searchParams.get(SIDE_PANEL_PARAM));

  const open = useCallback(
    (name: SidePanelName) => {
      setSearchParams((current) => nextSidePanelParams(current, name), {
        state: SIDE_PANEL_LINK_STATE,
      });
    },
    [setSearchParams]
  );

  const pushed = pushedByApp(location.state);
  const close = useCallback(() => {
    if (pushed) {
      navigate(-1);
      return;
    }
    setSearchParams((current) => nextSidePanelParams(current, null), { replace: true });
  }, [pushed, navigate, setSearchParams]);

  const hrefFor = useCallback(
    (name: SidePanelName) => sidePanelHref(searchParams, name),
    [searchParams]
  );

  return { panel, open, close, hrefFor };
}
