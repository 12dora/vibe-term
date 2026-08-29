// 站点品牌（logo + 名称）的唯一渲染点：侧栏顶部、无侧栏页面的顶栏、登录卡片都用它，
// 换名/换图只改这里与 `@tmex/shared` 的品牌常量。
//
// 主标题恒为**产品名**（`PRODUCT_NAME`），副标题是**本机 node 名**（浏览器所连的那台
// 入口机，不是 `/n/:nodeId` 当前浏览的 node）。
//
// **必须能在 RuntimeProvider 之外渲染**——`/login` 挂在 node
// 运行时边界之外，`useRuntime()` 在那里会直接抛错，所以走 `useOptionalRuntime()`：
// 拿不到运行时就只剩产品名。

import { getMeshNodesState, subscribeMeshNodes } from '@/node/mesh-nodes';
import { BRAND_LOGO_SRC, PRODUCT_NAME } from '@tmex/shared';
import { useOptionalRuntime } from '@tmex/stores/react';
import { type ComponentType, type ReactNode, useSyncExternalStore } from 'react';
import { Link } from 'react-router';

export { BRAND_LOGO_SRC, PRODUCT_NAME };

const NO_STORE_SUBSCRIBE = () => () => undefined;

/**
 * 站点名：有运行时就取该 node 的 site 设置，否则退回产品名。
 * 只读不拉取——`GET /api/settings/site` 在 mesh 下需要会话，登录页触发会 401，
 * 会话拦截器随即再导航一次 /login 并丢掉 next 参数；设置的加载仍归外壳（SidebarTitle）。
 */
export function useBrandName(): string {
  const siteStore = useOptionalRuntime()?.stores.site;
  const readName = () => siteStore?.getState().settings?.siteName || PRODUCT_NAME;
  return useSyncExternalStore(siteStore?.subscribe ?? NO_STORE_SUBSCRIBE, readName, readName);
}

/**
 * 本机 node 名：mesh 下取 `/api/mesh/nodes` 里 entry 自身那一行的 `name`（gateway 的
 * `selfName` 已把 hub 下发的名字/本地 node 行/站点名依次兜好）。
 *
 * **只被动读宿主级 store，不发任何请求**：Brand 会在登录页渲染，那里 `/api/mesh/nodes`
 * 必然 401；列表的加载归外壳（侧栏的 `SideBarDeviceList` / 设置页）。因此登录页与
 * standalone 下这里拿不到 mesh 名字，退回站点名。
 *
 * standalone 没有 node 概念，`/api/auth/mode` 只返回 `{mode:'none'}`，本机压根没有对外
 * 暴露的 node 名——退回站点名（默认也叫 `tmex`）。与产品名相同时返回 `null`，避免
 * 品牌块出现「tmex / tmex」两行重复。
 */
export function useLocalNodeName(): string | null {
  const mesh = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  const siteName = useBrandName();
  const entryNodeId = mesh.entryNodeId;
  const meshName = entryNodeId
    ? (mesh.nodes.find((node) => node.id === entryNodeId)?.name ?? null)
    : null;
  const name = (meshName || siteName || '').trim();
  return !name || name === PRODUCT_NAME ? null : name;
}

export type BrandSize = 'sm' | 'md';

export interface BrandLinkProps {
  to: string;
  className?: string;
  children?: ReactNode;
}

export interface BrandProps {
  className?: string;
  /** `md`（默认）用于侧栏，`sm` 用于顶栏。 */
  size?: BrandSize;
  /** 关掉后只留 logo。 */
  showName?: boolean;
  /** 给了就把整块包成链接。 */
  linkTo?: string;
  /**
   * 链接组件；侧栏传 `NavLink`（跟随当前 node 前缀并在移动端收起抽屉，但依赖
   * SidebarProvider），默认用 react-router 的 `Link`，无侧栏页面用它。
   */
  linkComponent?: ComponentType<BrandLinkProps>;
}

const LOGO_SIZE: Record<BrandSize, string> = {
  sm: 'h-6 w-6 rounded-md',
  md: 'h-8 w-8 rounded-lg',
};

export function Brand({
  className,
  size = 'md',
  showName = true,
  linkTo,
  linkComponent,
}: BrandProps) {
  const nodeName = useLocalNodeName();
  // `sm` 是无侧栏页面的顶栏，必须保持单行高度，只留产品名。
  const secondLine = showName && size === 'md' ? nodeName : null;
  const title = secondLine ? `${PRODUCT_NAME} · ${secondLine}` : PRODUCT_NAME;

  const content = (
    <>
      <span className={`${LOGO_SIZE[size]} block shrink-0 overflow-hidden border-2 border-black`}>
        {/* 名称同屏时 logo 不重复念一遍；只有 logo 时它才承担可访问名称 */}
        <img
          src={BRAND_LOGO_SRC}
          alt={showName ? '' : PRODUCT_NAME}
          className="h-full w-full object-cover"
        />
      </span>
      {showName ? (
        <span className="flex min-w-0 flex-col justify-center leading-tight">
          <span className="truncate text-sm font-semibold tracking-tight" data-testid="brand-name">
            {PRODUCT_NAME}
          </span>
          {secondLine ? (
            <span
              className="truncate text-[11px] text-muted-foreground"
              data-testid="brand-node-name"
            >
              {secondLine}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );

  const shell = `flex items-center gap-3 overflow-hidden ${className ?? ''}`.trimEnd();
  if (!linkTo) {
    return (
      <span className={shell} data-testid="brand" title={title}>
        {content}
      </span>
    );
  }

  const LinkAs = linkComponent ?? Link;
  return (
    <LinkAs to={linkTo} className={shell}>
      <span className="flex items-center gap-3 overflow-hidden" data-testid="brand" title={title}>
        {content}
      </span>
    </LinkAs>
  );
}

export default Brand;
