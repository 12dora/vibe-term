import type { GatewayTransportSourceRoute } from '@tmex/ws-client';
import type { TerminalSurfaceDiagnosticState } from './TerminalSurface';
import type { TerminalStreamDiagnosticInput } from './terminal-diagnostics';

/**
 * 把渲染面的诊断状态摊平成上报结构。渲染面尚未建立（首屏 await 中、初始化失败）时
 * 取 initializing 与全零计数，让上报链路无需区分「没有面」与「面是空的」。
 */
export function terminalStreamDiagnostic(
  sourceRoute: GatewayTransportSourceRoute,
  state: TerminalSurfaceDiagnosticState | null | undefined
): TerminalStreamDiagnosticInput {
  return {
    sourceRoute,
    paneEpoch: state?.paneEpoch ?? null,
    // 字节直通后渲染层不再持有终端游标与客户端 replay ring
    terminalSeq: null,
    historyEpoch: state?.historyEpoch ?? null,
    historyBeforeLine: state?.historyBeforeLine ?? null,
    recoveryState: state?.recoveryState ?? 'initializing',
    recoveryReason: state?.recoveryReason ?? null,
    replayBytes: 0,
    replayBytesLimit: 0,
    historyBytes: state?.historyBytes ?? 0,
    historyBytesLimit: state?.historyBytesLimit ?? 0,
    historyPages: state?.historyPages ?? 0,
    historyPagesLimit: state?.historyPagesLimit ?? 0,
  };
}
