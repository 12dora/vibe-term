import type { ControlStreamMetricsSnapshot } from './control-stream-metrics';

export function formatTmuxMetricsLine(metrics: ControlStreamMetricsSnapshot): string {
  return (
    `[tmux-metrics] control_stream interval_ms=${metrics.intervalMs} ` +
    `raw_chunks=${metrics.rawChunks} raw_bytes=${metrics.rawBytes} ` +
    `control_outputs=${metrics.controlOutputs} ` +
    `control_output_bytes=${metrics.controlOutputBytes} ` +
    `terminal_outputs=${metrics.terminalOutputs} ` +
    `terminal_output_bytes=${metrics.terminalOutputBytes} ` +
    `titles=${metrics.titles} bells=${metrics.bells} ` +
    `notifications=${metrics.notifications} ` +
    `structure_changes=${metrics.structureChanges} blocks=${metrics.blocks}`
  );
}
