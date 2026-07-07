import { useSidebar } from '@tmex/ui/sidebar';
import { Link, type LinkProps } from 'react-router';

interface NavLinkProps extends LinkProps {
  children?: React.ReactNode;
}

export function NavLink({ children, onClick, ...props }: NavLinkProps) {
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (isMobile) {
      setOpenMobile(false);
    }
    onClick?.(e);
  };

  return (
    <Link {...props} onClick={handleClick}>
      {children}
    </Link>
  );
}
