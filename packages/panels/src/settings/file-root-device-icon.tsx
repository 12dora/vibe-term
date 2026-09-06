import type { DeviceType } from '@vibeterm/shared';
import { Globe, Monitor } from 'lucide-react';

export function FileRootDeviceIcon({
  type,
  className,
}: {
  type: DeviceType | null;
  className?: string;
}) {
  if (type === 'ssh') {
    return <Globe className={className} />;
  }
  return <Monitor className={className} />;
}
