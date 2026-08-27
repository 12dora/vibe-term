import { hostAppPath } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { useSidebar } from '@tmex/ui/sidebar';
import { Link, type LinkProps } from 'react-router';

interface NavLinkProps extends LinkProps {
  children?: React.ReactNode;
}

export function NavLink({ children, onClick, to, ...props }: NavLinkProps) {
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
    <Link {...props} to={target} onClick={handleClick}>
      {children}
    </Link>
  );
}
