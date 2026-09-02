export type FailoverCause = 'stream_close' | 'send_failed';

export function failoverCauseOf(info?: { code?: number; reason?: string }): FailoverCause {
  return info?.reason === 'send-failed' ? 'send_failed' : 'stream_close';
}

export function formatFailoverStart(fields: {
  nodeId: string;
  cid?: string;
  pumpId: string;
  muxStreamId?: number | null;
  cause: FailoverCause;
  closeReason?: string;
  from: string;
  linkSinceAt?: number | null;
  queuedInputBytes: number;
}): string {
  const cid = fields.cid || '-';
  const muxStreamId = fields.muxStreamId ?? '-';
  const closeReason = fields.closeReason || '-';
  const linkSinceAt = fields.linkSinceAt ?? '-';
  return (
    `[mesh][stream] failover_start node=${fields.nodeId} cid=${cid} stream=${fields.pumpId} ` +
    `muxStreamId=${muxStreamId} cause=${fields.cause} close_reason=${closeReason} ` +
    `from=${fields.from} linkSinceAt=${linkSinceAt} queued_input_bytes=${fields.queuedInputBytes}`
  );
}

export function formatFailoverAttempt(fields: {
  pumpId: string;
  attempt: number;
  getLinkMs: number;
  openStreamMs: number;
  helloWaitMs: number;
  resumeWaitMs: number;
}): string {
  return (
    `[mesh][stream] failover_attempt stream=${fields.pumpId} attempt=${fields.attempt} ` +
    `getLink_ms=${fields.getLinkMs} open_stream_ms=${fields.openStreamMs} ` +
    `hello_wait_ms=${fields.helloWaitMs} resume_wait_ms=${fields.resumeWaitMs}`
  );
}

export function formatFailoverDone(fields: {
  pumpId: string;
  durationMs: number;
  to: string;
  resumed: number;
  replayMode: string;
  replayBytes: number;
}): string {
  return (
    `[mesh][stream] failover_done stream=${fields.pumpId} duration_ms=${fields.durationMs} ` +
    `to=${fields.to} resumed=${fields.resumed} replay_mode=${fields.replayMode} ` +
    `replay_bytes=${fields.replayBytes}`
  );
}

export function formatFailoverSummary(fields: {
  pumpId: string;
  durationMs: number;
  cause: FailoverCause;
  closeReason?: string;
  from: string;
  to: string;
  replayBytes: number;
  eventLoopLagMs: number;
  maxLagMs: number;
}): string {
  const closeReason = fields.closeReason || '-';
  return (
    `[mesh][stream] failover_summary stream=${fields.pumpId} duration_ms=${fields.durationMs} ` +
    `cause=${fields.cause} close_reason=${closeReason} from=${fields.from} to=${fields.to} ` +
    `replay_bytes=${fields.replayBytes} event_loop_lag_ms=${fields.eventLoopLagMs} max_lag_ms=${fields.maxLagMs}`
  );
}
