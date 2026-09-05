import { type ChunkPreloadTarget, preloadChunk } from '@/lib/chunk-preload';
import { hostAppPath } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { useSidebar } from '@tmex/ui/sidebar';
import { Link, type LinkProps } from 'react-router';

interface NavLinkProps extends LinkProps {
  children?: React.ReactNode;
  /**
   * 目标路由页的模块 loader（与路由表共用同一个函数引用）。指针悬停 / 触摸开始时先把
   * chunk 拉下来，点击时就只剩渲染与数据请求；预热失败静默，真正导航过去时才该报错。
   */
  preload?: ChunkPreloadTarget;
}

/** 预热包一层原有的事件处理：没给 preload 时原样透传，不多包一个闭包。 */
export function withChunkPreload<E>(
  preload: ChunkPreloadTarget | undefined,
  handler: ((event: E) => void) | undefined
): ((event: E) => void) | undefined {
  if (!preload) return handler;
  return (event: E) => {
    preloadChunk(preload);
    handler?.(event);
  };
}

export function NavLink({
  children,
  onClick,
  onPointerEnter,
  onTouchStart,
  to,
  preload,
  ...props
}: NavLinkProps) {
  const { isMobile, setOpenMobile } = useSidebar();
  const { host } = useRuntime();

  // 外壳内的绝对路径（/、/devices、/settings…）跟随当前 node 边界加 `/n/:id` 前缀。
  const target = typeof to === 'string' && to.startsWith('/') ? hostAppPath(host, to) : to;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    onClick?.(e);
  };

  return (
    <Link
      {...props}
      to={target}
      onClick={handleClick}
      onPointerEnter={withChunkPreload(preload, onPointerEnter)}
      onTouchStart={withChunkPreload(preload, onTouchStart)}
    >
      {children}
    </Link>
  );
}
