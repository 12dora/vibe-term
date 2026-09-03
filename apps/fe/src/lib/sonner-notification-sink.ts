// NotificationSink 的 sonner 适配器（开源外壳的默认通知出口）

import type { NotificationOptions, NotificationSink } from '@tmex/notifications';
import { toast } from '@tmex/ui/toast';

function toSonnerOptions(options?: NotificationOptions) {
  if (!options) return undefined;
  return {
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.duration !== undefined ? { duration: options.duration } : {}),
    ...(options.action
      ? { action: { label: options.action.label, onClick: options.action.onClick } }
      : {}),
  };
}

export const sonnerNotificationSink: NotificationSink = {
  info(title, options) {
    toast(title, toSonnerOptions(options));
  },
  success(title, options) {
    toast.success(title, toSonnerOptions(options));
  },
  warning(title, options) {
    toast.warning(title, toSonnerOptions(options));
  },
  error(title, options) {
    toast.error(title, toSonnerOptions(options));
  },
};
