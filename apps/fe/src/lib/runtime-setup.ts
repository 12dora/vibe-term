// 默认 runtime 的宿主注入：main.tsx 最先 import，早于任何通知路径触发。

import { setDefaultNotificationSink } from '@tmex/stores';
import { sonnerNotificationSink } from './sonner-notification-sink';

setDefaultNotificationSink(sonnerNotificationSink);
