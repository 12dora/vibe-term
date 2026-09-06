// 接收侧共用一个 `ResumableSink` 实例：会话生命周期与逐文件操作分处两个模块，
// 但半成品的并发闸门在引擎内是按 `.part` 路径全局维护的，实例必须是同一个。

import { ResumableSink } from '@tmex/transfer/node';

export const receiverSink = new ResumableSink();
