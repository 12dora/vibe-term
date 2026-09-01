// WebSocket Borsh 协议单元测试
// 测试范围: codec, chunk, convert

import { beforeEach, describe, expect, it } from 'bun:test';
import {
  AGENT_EVENT_SYNC,
  CURRENT_VERSION,
  ChunkReassembler,
  ERROR_FRAME_TOO_LARGE,
  ERROR_INVALID_FRAME,
  KIND_AGENT_EVENT,
  KIND_AGENT_SUBSCRIBE,
  KIND_AGENT_UNSUBSCRIBE,
  KIND_CHUNK,
  KIND_CLIPBOARD_WRITE,
  KIND_NOTIFY_EVENT,
  KIND_PING,
  KIND_PONG,
  KIND_SITE_THEME_UPDATE,
  KIND_TERM_VIEWPORT,
  KIND_TERM_VIEWPORT_POLICY,
  KIND_TMUX_REORDER_PANES,
  KIND_TMUX_REORDER_WINDOWS,
  KIND_WATCH_EVENT,
  MAGIC,
  MAX_CHUNK_STREAMS,
  SITE_THEME_DARK,
  SITE_THEME_LIGHT,
  WATCH_EVENT_TRIGGERED,
  WsBorshError,
  checkMagic,
  createSeqGenerator,
  decodeEnvelope,
  decodeNodeEvent,
  decodePayload,
  encodeChunk,
  encodeEnvelope,
  encodeNodeEvent,
  encodePayload,
  generateChunkStreamId,
  getErrorMessage,
  isValidKind,
  kindToString,
  resetChunkStreamId,
  splitPayloadIntoChunks,
} from './index';
import {
  KIND_CARRIER_SWITCH,
  KIND_CARRIER_SWITCH_ACK,
  KIND_ENROLL_REDEEMED,
  KIND_NODE_EVENT,
  KIND_RTC_SIGNAL,
} from './kind';
import {
  AgentEventSchema,
  AgentSubscribeSchema,
  AgentUnsubscribeSchema,
  CARRIER_SWITCH_TO_DIRECT,
  CARRIER_SWITCH_TO_PRIMARY,
  CarrierSwitchAckSchema,
  CarrierSwitchSchema,
  ClipboardWriteSchema,
  ENROLL_REDEEMED_MAX_CERT_BYTES,
  EnrollRedeemedSchema,
  EventNotifyS2CSchema,
  NODE_EVENT_STATUS_OFFLINE,
  NODE_EVENT_STATUS_ONLINE,
  NODE_EVENT_STATUS_REVOKED,
  NodeEventLegacySchema,
  NodeEventSchema,
  NodeEventV2Schema,
  PingPongSchema,
  RTC_SIGNAL_FROM_BROWSER,
  RTC_SIGNAL_FROM_NODE,
  RtcSignalSchema,
  SiteThemeUpdateC2SSchema,
  SiteThemeUpdateS2CSchema,
  TermViewportPolicySchema,
  TermViewportSchema,
  TmuxReorderPanesSchema,
  TmuxReorderWindowsSchema,
  WatchEventSchema,
  assertEnrollRedeemedFields,
} from './schema';

describe('codec', () => {
  describe('encodeEnvelope / decodeEnvelope', () => {
    it('应该正确编码和解码 envelope', () => {
      const kind = 0x0003; // PING
      const payload = new Uint8Array([1, 2, 3, 4]);
      const seq = 42;
      const flags = 0;

      const encoded = encodeEnvelope(kind, payload, seq, flags);
      expect(encoded).toBeInstanceOf(Uint8Array);
      expect(encoded.length).toBeGreaterThan(12);

      const decoded = decodeEnvelope(encoded);
      expect(decoded.magic).toEqual(MAGIC);
      expect(decoded.version).toBe(CURRENT_VERSION);
      expect(decoded.kind).toBe(kind);
      expect(decoded.flags).toBe(flags);
      expect(decoded.seq).toBe(seq);
      expect(decoded.payload).toEqual(payload);
    });

    it('应该支持自定义版本', () => {
      const payload = new Uint8Array([1, 2, 3]);
      const encoded = encodeEnvelope(1, payload, 1, 0, 2);
      const decoded = decodeEnvelope(encoded);
      expect(decoded.version).toBe(2);
    });

    it('应该支持自定义 flags', () => {
      const payload = new Uint8Array([1, 2, 3]);
      const flags = 0b1010;
      const encoded = encodeEnvelope(1, payload, 1, flags);
      const decoded = decodeEnvelope(encoded);
      expect(decoded.flags).toBe(flags);
    });

    it('应该对无效数据抛出错误', () => {
      expect(() => decodeEnvelope(new Uint8Array([1, 2, 3]))).toThrow(WsBorshError);
    });

    it('应该检查 magic 字节', () => {
      const invalidData = new Uint8Array([
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      expect(() => decodeEnvelope(invalidData)).toThrow(WsBorshError);
    });
  });

  describe('checkMagic', () => {
    it('应该正确识别 magic', () => {
      expect(checkMagic(MAGIC)).toBe(true);
      expect(checkMagic(new Uint8Array([0x54, 0x58]))).toBe(true);
      expect(checkMagic(new Uint8Array([0x00, 0x00]))).toBe(false);
      expect(checkMagic(new Uint8Array([0x54]))).toBe(false);
    });
  });

  describe('seq generator', () => {
    it('应该生成递增的 seq', () => {
      const gen = createSeqGenerator();
      expect(gen()).toBe(1);
      expect(gen()).toBe(2);
      expect(gen()).toBe(3);
    });
  });

  describe('payload 编解码', () => {
    it('应该正确编解码 PingPong payload', () => {
      const data = { nonce: 12345, timeMs: 67890n };
      const encoded = encodePayload(PingPongSchema, data);
      const decoded = decodePayload(PingPongSchema, encoded);
      expect(decoded.nonce).toBe(data.nonce);
      expect(decoded.timeMs).toBe(data.timeMs);
    });
  });
});

describe('chunk', () => {
  beforeEach(() => {
    resetChunkStreamId();
  });

  describe('ChunkReassembler', () => {
    it('应该重组分片消息', () => {
      const reassembler = new ChunkReassembler();
      const streamId = 1;
      const originalPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

      // 分割成 2 个 chunks
      const chunk1 = {
        chunkStreamId: streamId,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 0,
        data: originalPayload.slice(0, 4),
      };

      const chunk2 = {
        chunkStreamId: streamId,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 1,
        data: originalPayload.slice(4, 8),
      };

      const result1 = reassembler.addChunk(chunk1);
      expect(result1).toBeNull();

      const result2 = reassembler.addChunk(chunk2);
      expect(result2).not.toBeNull();
      if (result2) {
        expect(result2.kind).toBe(KIND_PING);
        expect(result2.seq).toBe(100);
        expect(result2.payload).toEqual(originalPayload);
      }
    });

    it('应该检测重复 chunk', () => {
      const reassembler = new ChunkReassembler();
      const chunk = {
        chunkStreamId: 1,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 0,
        data: new Uint8Array([1, 2, 3]),
      };

      reassembler.addChunk(chunk);
      expect(() => reassembler.addChunk(chunk)).toThrow(WsBorshError);
    });

    it('应该检测越界 index', () => {
      const reassembler = new ChunkReassembler();
      const chunk = {
        chunkStreamId: 1,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 5, // 越界
        data: new Uint8Array([1, 2, 3]),
      };

      expect(() => reassembler.addChunk(chunk)).toThrow(WsBorshError);
    });

    it('应该限制最大 chunk 数量', () => {
      const reassembler = new ChunkReassembler();
      const chunk = {
        chunkStreamId: 1,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2000, // 超过限制
        chunkIndex: 0,
        data: new Uint8Array([1]),
      };

      expect(() => reassembler.addChunk(chunk)).toThrow(WsBorshError);
    });

    it('应该清理过期流', () => {
      let now = 0;
      const reassembler = new ChunkReassembler({ timeoutMs: 100, now: () => now });

      // 添加一个正常 chunk，但模拟其已过期
      const chunk = {
        chunkStreamId: 1,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex: 0,
        data: new Uint8Array([1, 2, 3]),
      };
      reassembler.addChunk(chunk);
      now = 101;
      reassembler.cleanup();
      expect(reassembler.getActiveStreamCount()).toBe(0);
    });

    it('持续到达的低速分片按无进展窗口保活，而不是按首块总时长过期', () => {
      let now = 0;
      const reassembler = new ChunkReassembler({ timeoutMs: 100, now: () => now });
      const chunk = (chunkIndex: number) => ({
        chunkStreamId: 7,
        originalKind: KIND_PING,
        originalSeq: 9,
        totalChunks: 3,
        chunkIndex,
        data: new Uint8Array([chunkIndex]),
      });

      expect(reassembler.addChunk(chunk(0))).toBeNull();
      now = 90;
      expect(reassembler.addChunk(chunk(1))).toBeNull();
      now = 180;
      expect(reassembler.addChunk(chunk(2))?.payload).toEqual(new Uint8Array([0, 1, 2]));
    });

    it('混入其它消息元数据的分片被拒绝并作废整条流', () => {
      const reassembler = new ChunkReassembler();
      const base = {
        chunkStreamId: 11,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        data: new Uint8Array([1]),
      };

      expect(reassembler.addChunk({ ...base, chunkIndex: 0 })).toBeNull();
      expect(() =>
        reassembler.addChunk({ ...base, chunkIndex: 1, originalKind: KIND_PONG })
      ).toThrow(WsBorshError);
      expect(reassembler.getActiveStreamCount()).toBe(0);

      expect(reassembler.addChunk({ ...base, chunkIndex: 0 })).toBeNull();
      expect(() => reassembler.addChunk({ ...base, chunkIndex: 1, originalSeq: 101 })).toThrow(
        WsBorshError
      );
      expect(reassembler.getActiveStreamCount()).toBe(0);
    });

    it('重复 index 作废整条流，后续补齐的分片不会重组出消息', () => {
      const reassembler = new ChunkReassembler();
      const chunk = (chunkIndex: number) => ({
        chunkStreamId: 12,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        chunkIndex,
        data: new Uint8Array([chunkIndex]),
      });

      expect(reassembler.addChunk(chunk(0))).toBeNull();
      expect(() => reassembler.addChunk(chunk(0))).toThrow(WsBorshError);
      expect(reassembler.getActiveStreamCount()).toBe(0);

      expect(reassembler.addChunk(chunk(1))).toBeNull();
      expect(reassembler.getActiveStreamCount()).toBe(1);
    });

    it('并发流达到上限后拒绝新流，且不驱逐已有流；过期后才腾出配额', () => {
      let now = 0;
      const reassembler = new ChunkReassembler({ timeoutMs: 100, now: () => now });
      const chunk = (chunkStreamId: number) => ({
        chunkStreamId,
        originalKind: KIND_PING,
        originalSeq: chunkStreamId,
        totalChunks: 2,
        chunkIndex: 0,
        data: new Uint8Array([1]),
      });

      for (let streamId = 1; streamId <= MAX_CHUNK_STREAMS; streamId += 1) {
        expect(reassembler.addChunk(chunk(streamId))).toBeNull();
      }
      expect(reassembler.getActiveStreamCount()).toBe(MAX_CHUNK_STREAMS);

      expect(() => reassembler.addChunk(chunk(MAX_CHUNK_STREAMS + 1))).toThrow(WsBorshError);
      expect(reassembler.getActiveStreamCount()).toBe(MAX_CHUNK_STREAMS);

      // 已有流未被驱逐：补齐分片仍能重组
      expect(reassembler.addChunk({ ...chunk(1), chunkIndex: 1 })?.seq).toBe(1);
      expect(reassembler.getActiveStreamCount()).toBe(MAX_CHUNK_STREAMS - 1);
      expect(reassembler.addChunk(chunk(MAX_CHUNK_STREAMS + 1))).toBeNull();

      now = 101;
      expect(reassembler.addChunk(chunk(MAX_CHUNK_STREAMS + 2))).toBeNull();
      expect(reassembler.getActiveStreamCount()).toBe(1);
    });

    it('越界 index 作废整条流', () => {
      const reassembler = new ChunkReassembler();
      const base = {
        chunkStreamId: 13,
        originalKind: KIND_PING,
        originalSeq: 100,
        totalChunks: 2,
        data: new Uint8Array([1]),
      };

      expect(reassembler.addChunk({ ...base, chunkIndex: 0 })).toBeNull();
      expect(() => reassembler.addChunk({ ...base, chunkIndex: 2 })).toThrow(WsBorshError);
      expect(reassembler.getActiveStreamCount()).toBe(0);
    });
  });

  describe('splitPayloadIntoChunks', () => {
    it('应该正确分割 payload', () => {
      const payload = new Uint8Array(5000);
      for (let i = 0; i < 5000; i++) {
        payload[i] = i % 256;
      }

      const result = splitPayloadIntoChunks(payload, KIND_PING, 1, {
        maxFrameBytes: 2048,
        chunkStreamId: 1,
      });

      expect(result.totalChunks).toBeGreaterThan(1);
      expect(result.chunks.length).toBe(result.totalChunks);

      // 验证所有 chunks 的数据总和
      let totalLength = 0;
      for (const chunk of result.chunks) {
        totalLength += chunk.data.length;
        expect(chunk.chunkStreamId).toBe(1);
        expect(chunk.originalKind).toBe(KIND_PING);
        expect(chunk.originalSeq).toBe(1);
      }
      expect(totalLength).toBe(payload.length);
    });

    it('小 payload 不需要分片', () => {
      const payload = new Uint8Array([1, 2, 3, 4]);
      const result = splitPayloadIntoChunks(payload, KIND_PING, 1, {
        maxFrameBytes: 2048,
        chunkStreamId: 1,
      });

      expect(result.totalChunks).toBe(0);
      expect(result.chunks.length).toBe(0);
    });

    it('应该保证 chunk envelope 不超过 maxFrameBytes', () => {
      const maxFrameBytes = 256;
      const payload = new Uint8Array(2048).fill(0xab);

      const result = splitPayloadIntoChunks(payload, KIND_PING, 123, {
        maxFrameBytes,
        chunkStreamId: 1,
      });

      expect(result.totalChunks).toBeGreaterThan(0);

      for (const chunk of result.chunks) {
        const encoded = encodeChunk(chunk, 1);
        expect(encoded.length).toBeLessThanOrEqual(maxFrameBytes);
      }
    });

    it('maxFrameBytes 过小应抛出错误', () => {
      const payload = new Uint8Array([1, 2, 3]);
      expect(() =>
        splitPayloadIntoChunks(payload, KIND_PING, 1, {
          maxFrameBytes: 8,
          chunkStreamId: 1,
        })
      ).toThrow(WsBorshError);

      try {
        splitPayloadIntoChunks(payload, KIND_PING, 1, { maxFrameBytes: 8, chunkStreamId: 1 });
      } catch (e) {
        expect((e as WsBorshError).code).toBe(ERROR_FRAME_TOO_LARGE);
      }
    });
  });

  describe('generateChunkStreamId', () => {
    it('应该生成递增的 stream id', () => {
      resetChunkStreamId();
      expect(generateChunkStreamId()).toBe(1);
      expect(generateChunkStreamId()).toBe(2);
      expect(generateChunkStreamId()).toBe(3);
    });
  });
});

describe('kind', () => {
  it('应该验证有效的 kind', () => {
    expect(isValidKind(0x0001)).toBe(true); // HELLO_C2S
    expect(isValidKind(0x0501)).toBe(true); // CHUNK
    expect(isValidKind(KIND_AGENT_SUBSCRIBE)).toBe(true);
    expect(isValidKind(KIND_AGENT_UNSUBSCRIBE)).toBe(true);
    expect(isValidKind(KIND_AGENT_EVENT)).toBe(true);
    expect(isValidKind(KIND_WATCH_EVENT)).toBe(true);
    expect(isValidKind(KIND_CLIPBOARD_WRITE)).toBe(true);
    expect(isValidKind(0x9999)).toBe(false);
    expect(isValidKind(0)).toBe(false);
  });

  it('应该返回 kind 字符串表示', () => {
    expect(kindToString(0x0001)).toBe('HELLO_C2S');
    expect(kindToString(0x0501)).toBe('CHUNK');
    expect(kindToString(KIND_AGENT_SUBSCRIBE)).toBe('AGENT_SUBSCRIBE');
    expect(kindToString(KIND_AGENT_UNSUBSCRIBE)).toBe('AGENT_UNSUBSCRIBE');
    expect(kindToString(KIND_AGENT_EVENT)).toBe('AGENT_EVENT');
    expect(kindToString(KIND_WATCH_EVENT)).toBe('WATCH_EVENT');
    expect(kindToString(KIND_CLIPBOARD_WRITE)).toBe('CLIPBOARD_WRITE');
    expect(kindToString(0x9999)).toBe('UNKNOWN(0x9999)');
  });
});

describe('tmux reorder 协议消息', () => {
  it('REORDER_WINDOWS/REORDER_PANES kind 有效且可读名', () => {
    expect(isValidKind(KIND_TMUX_REORDER_WINDOWS)).toBe(true);
    expect(isValidKind(KIND_TMUX_REORDER_PANES)).toBe(true);
    expect(kindToString(KIND_TMUX_REORDER_WINDOWS)).toBe('TMUX_REORDER_WINDOWS');
    expect(kindToString(KIND_TMUX_REORDER_PANES)).toBe('TMUX_REORDER_PANES');
  });

  it('TmuxReorderWindows payload roundtrip（含字符串数组）', () => {
    const data = { deviceId: 'dev-1', windowIds: ['@2', '@0', '@1'] };
    const decoded = decodePayload(
      TmuxReorderWindowsSchema,
      encodePayload(TmuxReorderWindowsSchema, data)
    );
    expect(decoded.deviceId).toBe('dev-1');
    expect(decoded.windowIds).toEqual(['@2', '@0', '@1']);
  });

  it('TmuxReorderPanes payload roundtrip', () => {
    const data = { deviceId: 'dev-1', windowId: '@0', paneIds: ['%3', '%1', '%2'] };
    const decoded = decodePayload(
      TmuxReorderPanesSchema,
      encodePayload(TmuxReorderPanesSchema, data)
    );
    expect(decoded.deviceId).toBe('dev-1');
    expect(decoded.windowId).toBe('@0');
    expect(decoded.paneIds).toEqual(['%3', '%1', '%2']);
  });

  it('空数组 roundtrip', () => {
    const decoded = decodePayload(
      TmuxReorderWindowsSchema,
      encodePayload(TmuxReorderWindowsSchema, { deviceId: 'd', windowIds: [] })
    );
    expect(decoded.windowIds).toEqual([]);
  });
});

describe('term viewport 协议消息', () => {
  it('KIND_TERM_VIEWPORT / KIND_TERM_VIEWPORT_POLICY 有效且可读名', () => {
    expect(KIND_TERM_VIEWPORT).toBe(0x0308);
    expect(KIND_TERM_VIEWPORT_POLICY).toBe(0x0309);
    expect(isValidKind(KIND_TERM_VIEWPORT)).toBe(true);
    expect(isValidKind(KIND_TERM_VIEWPORT_POLICY)).toBe(true);
    expect(kindToString(KIND_TERM_VIEWPORT)).toBe('TERM_VIEWPORT');
    expect(kindToString(KIND_TERM_VIEWPORT_POLICY)).toBe('TERM_VIEWPORT_POLICY');
  });

  it('TermViewportSchema payload roundtrip', () => {
    const data = { deviceId: 'dev-1', paneId: '%0', cols: 120, rows: 40, visible: true };
    const decoded = decodePayload(TermViewportSchema, encodePayload(TermViewportSchema, data));
    expect(decoded).toEqual(data);

    const hidden = decodePayload(
      TermViewportSchema,
      encodePayload(TermViewportSchema, { ...data, visible: false, cols: 80, rows: 24 })
    );
    expect(hidden.visible).toBe(false);
    expect(hidden.cols).toBe(80);
    expect(hidden.rows).toBe(24);
  });

  it('TermViewportPolicySchema envelope + payload roundtrip', () => {
    const data = {
      deviceId: 'dev-1',
      windowId: '@2',
      paneId: '%3',
      owner: false,
      cols: 160,
      rows: 48,
    };
    const payloadBytes = encodePayload(TermViewportPolicySchema, data);
    const envelope = encodeEnvelope(KIND_TERM_VIEWPORT_POLICY, payloadBytes, 11);
    const decodedEnvelope = decodeEnvelope(envelope);
    expect(decodedEnvelope.kind).toBe(KIND_TERM_VIEWPORT_POLICY);
    expect(decodePayload(TermViewportPolicySchema, decodedEnvelope.payload)).toEqual(data);

    const owner = decodePayload(
      TermViewportPolicySchema,
      encodePayload(TermViewportPolicySchema, { ...data, owner: true })
    );
    expect(owner.owner).toBe(true);
  });
});

describe('clipboard write 协议消息', () => {
  it('ClipboardWriteSchema payload roundtrip', () => {
    const data = { deviceId: 'dev-1', paneId: '%0', text: 'hello world' };
    const encoded = encodePayload(ClipboardWriteSchema, data);
    const decoded = decodePayload(ClipboardWriteSchema, encoded);
    expect(decoded.deviceId).toBe('dev-1');
    expect(decoded.paneId).toBe('%0');
    expect(decoded.text).toBe('hello world');
  });

  it('ClipboardWriteSchema with empty text roundtrip', () => {
    const data = { deviceId: 'dev-1', paneId: '%0', text: '' };
    const decoded = decodePayload(ClipboardWriteSchema, encodePayload(ClipboardWriteSchema, data));
    expect(decoded.text).toBe('');
  });

  it('ClipboardWriteSchema with unicode text roundtrip', () => {
    const data = { deviceId: 'dev-1', paneId: '%0', text: '你好世界 🌍' };
    const decoded = decodePayload(ClipboardWriteSchema, encodePayload(ClipboardWriteSchema, data));
    expect(decoded.text).toBe('你好世界 🌍');
  });
});

describe('agent/watch 协议消息', () => {
  it('AGENT_SUBSCRIBE/AGENT_UNSUBSCRIBE payload roundtrip', () => {
    for (const schema of [AgentSubscribeSchema, AgentUnsubscribeSchema]) {
      const encoded = encodePayload(schema, { sessionId: 'session-1' });
      const decoded = decodePayload(schema, encoded);
      expect(decoded.sessionId).toBe('session-1');
    }
  });

  it('AGENT_EVENT envelope + payload roundtrip（payload 为 JSON bytes）', () => {
    const jsonPayload = {
      status: 'running',
      lastError: null,
      inProgressText: 'hello',
      inProgressReasoning: '',
      pendingConfirmations: [],
      lastMessageSeq: 3,
    };
    const payloadBytes = encodePayload(AgentEventSchema, {
      sessionId: 'session-1',
      seq: 42,
      eventType: AGENT_EVENT_SYNC,
      payload: new TextEncoder().encode(JSON.stringify(jsonPayload)),
    });

    const envelope = encodeEnvelope(KIND_AGENT_EVENT, payloadBytes, 7);
    const decodedEnvelope = decodeEnvelope(envelope);
    expect(decodedEnvelope.kind).toBe(KIND_AGENT_EVENT);

    const decoded = decodePayload(AgentEventSchema, decodedEnvelope.payload);
    expect(decoded.sessionId).toBe('session-1');
    expect(decoded.seq).toBe(42);
    expect(decoded.eventType).toBe(AGENT_EVENT_SYNC);
    expect(JSON.parse(new TextDecoder().decode(decoded.payload))).toEqual(jsonPayload);
  });

  it('WATCH_EVENT envelope + payload roundtrip', () => {
    const jsonPayload = { summary: 'rule matched', matchedText: 'ERROR' };
    const payloadBytes = encodePayload(WatchEventSchema, {
      ruleId: 'rule-1',
      deviceId: 'device-1',
      paneId: '%1',
      eventType: WATCH_EVENT_TRIGGERED,
      payload: new TextEncoder().encode(JSON.stringify(jsonPayload)),
    });

    const envelope = encodeEnvelope(KIND_WATCH_EVENT, payloadBytes, 9);
    const decodedEnvelope = decodeEnvelope(envelope);
    expect(decodedEnvelope.kind).toBe(KIND_WATCH_EVENT);

    const decoded = decodePayload(WatchEventSchema, decodedEnvelope.payload);
    expect(decoded.ruleId).toBe('rule-1');
    expect(decoded.deviceId).toBe('device-1');
    expect(decoded.paneId).toBe('%1');
    expect(decoded.eventType).toBe(WATCH_EVENT_TRIGGERED);
    expect(JSON.parse(new TextDecoder().decode(decoded.payload))).toEqual(jsonPayload);
  });
});

describe('site theme update 协议消息', () => {
  it('SiteThemeUpdateC2S payload roundtrip（dark=0）', () => {
    const data = { theme: SITE_THEME_DARK };
    const decoded = decodePayload(
      SiteThemeUpdateC2SSchema,
      encodePayload(SiteThemeUpdateC2SSchema, data)
    );
    expect(decoded.theme).toBe(SITE_THEME_DARK);
  });

  it('SiteThemeUpdateC2S payload roundtrip（light=1）', () => {
    const data = { theme: SITE_THEME_LIGHT };
    const decoded = decodePayload(
      SiteThemeUpdateC2SSchema,
      encodePayload(SiteThemeUpdateC2SSchema, data)
    );
    expect(decoded.theme).toBe(SITE_THEME_LIGHT);
  });

  it('SiteThemeUpdateS2C payload roundtrip（含 serverTimestamp u64）', () => {
    const data = { theme: SITE_THEME_LIGHT, serverTimestamp: 1719900000000n };
    const decoded = decodePayload(
      SiteThemeUpdateS2CSchema,
      encodePayload(SiteThemeUpdateS2CSchema, data)
    );
    expect(decoded.theme).toBe(SITE_THEME_LIGHT);
    expect(decoded.serverTimestamp).toBe(1719900000000n);
  });

  it('KIND_SITE_THEME_UPDATE 在 valid kinds 中且 kindToString 可读', () => {
    expect(isValidKind(KIND_SITE_THEME_UPDATE)).toBe(true);
    expect(kindToString(KIND_SITE_THEME_UPDATE)).toBe('SITE_THEME_UPDATE');
  });

  it('envelope roundtrip KIND_SITE_THEME_UPDATE（S2C）', () => {
    const payload = encodePayload(SiteThemeUpdateS2CSchema, {
      theme: SITE_THEME_DARK,
      serverTimestamp: 42n,
    });
    const envelope = encodeEnvelope(KIND_SITE_THEME_UPDATE, payload, 7);
    const decoded = decodeEnvelope(envelope);
    expect(decoded.kind).toBe(KIND_SITE_THEME_UPDATE);
    const decodedPayload = decodePayload(SiteThemeUpdateS2CSchema, decoded.payload);
    expect(decodedPayload.theme).toBe(SITE_THEME_DARK);
    expect(decodedPayload.serverTimestamp).toBe(42n);
  });
});

describe('notify event 协议消息', () => {
  it('KIND_NOTIFY_EVENT = 0x0803，在 valid kinds 中且 kindToString 可读', () => {
    expect(KIND_NOTIFY_EVENT).toBe(0x0803);
    expect(isValidKind(KIND_NOTIFY_EVENT)).toBe(true);
    expect(kindToString(KIND_NOTIFY_EVENT)).toBe('NOTIFY_EVENT');
  });

  it('EventNotifyS2C envelope + payload roundtrip', () => {
    const eventJson = JSON.stringify({ eventType: 'terminal_bell', payload: { message: 'ding' } });
    const payloadBytes = encodePayload(EventNotifyS2CSchema, {
      eventType: 'terminal_bell',
      eventJson,
      timestamp: 1719900000000n,
    });

    const envelope = encodeEnvelope(KIND_NOTIFY_EVENT, payloadBytes, 11);
    const decodedEnvelope = decodeEnvelope(envelope);
    expect(decodedEnvelope.kind).toBe(KIND_NOTIFY_EVENT);

    const decoded = decodePayload(EventNotifyS2CSchema, decodedEnvelope.payload);
    expect(decoded.eventType).toBe('terminal_bell');
    expect(decoded.eventJson).toBe(eventJson);
    expect(decoded.timestamp).toBe(1719900000000n);
  });
});

describe('errors', () => {
  it('应该创建 WsBorshError', () => {
    const error = new WsBorshError(ERROR_INVALID_FRAME, true);
    expect(error.code).toBe(ERROR_INVALID_FRAME);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(getErrorMessage(ERROR_INVALID_FRAME));
  });

  it('应该支持自定义消息', () => {
    const error = new WsBorshError(ERROR_INVALID_FRAME, false, 'custom message');
    expect(error.message).toBe('custom message');
  });
});

describe('mesh / hub 协议消息', () => {
  it('KIND_NODE_EVENT / RTC_SIGNAL / CARRIER_SWITCH / ACK / ENROLL_REDEEMED 有效且可读名', () => {
    expect(KIND_NODE_EVENT).toBe(0x0a01);
    expect(KIND_RTC_SIGNAL).toBe(0x0a02);
    expect(KIND_CARRIER_SWITCH).toBe(0x0a03);
    expect(KIND_CARRIER_SWITCH_ACK).toBe(0x0a04);
    expect(KIND_ENROLL_REDEEMED).toBe(0x0a05);
    expect(isValidKind(KIND_NODE_EVENT)).toBe(true);
    expect(isValidKind(KIND_RTC_SIGNAL)).toBe(true);
    expect(isValidKind(KIND_CARRIER_SWITCH)).toBe(true);
    expect(isValidKind(KIND_CARRIER_SWITCH_ACK)).toBe(true);
    expect(isValidKind(KIND_ENROLL_REDEEMED)).toBe(true);
    expect(kindToString(KIND_NODE_EVENT)).toBe('NODE_EVENT');
    expect(kindToString(KIND_RTC_SIGNAL)).toBe('RTC_SIGNAL');
    expect(kindToString(KIND_CARRIER_SWITCH)).toBe('CARRIER_SWITCH');
    expect(kindToString(KIND_CARRIER_SWITCH_ACK)).toBe('CARRIER_SWITCH_ACK');
    expect(kindToString(KIND_ENROLL_REDEEMED)).toBe('ENROLL_REDEEMED');
  });

  it('NODE_EVENT payload roundtrip（含 option 字段）', () => {
    const data = {
      nodeId: 'aabbccddeeff00112233445566778899',
      status: NODE_EVENT_STATUS_ONLINE,
      reach: 'lan',
      inventory: '{"devices":[]}',
      version: null,
      directCapable: null,
      name: null,
      transport: null,
      rttMs: null,
    };
    const decoded = decodePayload(NodeEventSchema, encodePayload(NodeEventSchema, data));
    expect(decoded).toEqual(data);

    const offline = decodePayload(
      NodeEventSchema,
      encodePayload(NodeEventSchema, {
        nodeId: 'n1',
        status: NODE_EVENT_STATUS_OFFLINE,
        reach: null,
        inventory: null,
        version: null,
        directCapable: null,
        name: null,
        transport: null,
        rttMs: null,
      })
    );
    expect(offline.status).toBe(NODE_EVENT_STATUS_OFFLINE);
    expect(offline.reach).toBeNull();
    expect(offline.inventory).toBeNull();
    expect(NODE_EVENT_STATUS_REVOKED).toBe(2);
  });

  it('NODE_EVENT payload roundtrip includes version / directCapable / name', () => {
    const data = {
      nodeId: 'aabbccddeeff00112233445566778899',
      status: NODE_EVENT_STATUS_ONLINE,
      reach: 'lan',
      inventory: '{"devices":[]}',
      version: '1.2.3',
      directCapable: true,
      name: 'studio',
      transport: 'dc',
      rttMs: 7,
    };
    const decoded = decodePayload(NodeEventSchema, encodePayload(NodeEventSchema, data));
    expect(decoded).toEqual(data);

    const omitted = decodePayload(
      NodeEventSchema,
      encodePayload(NodeEventSchema, {
        nodeId: 'n1',
        status: NODE_EVENT_STATUS_OFFLINE,
        reach: null,
        inventory: null,
        version: null,
        directCapable: null,
        name: null,
        transport: null,
        rttMs: null,
      })
    );
    expect(omitted.version).toBeNull();
    expect(omitted.directCapable).toBeNull();
    expect(omitted.name).toBeNull();

    const legacy = decodeNodeEvent(
      encodePayload(NodeEventLegacySchema, {
        nodeId: 'n2',
        status: NODE_EVENT_STATUS_ONLINE,
        reach: 'relay',
        inventory: null,
      })
    );
    expect(legacy).toEqual({
      nodeId: 'n2',
      status: NODE_EVENT_STATUS_ONLINE,
      reach: 'relay',
      inventory: null,
      version: null,
      directCapable: null,
      name: null,
      transport: null,
      rttMs: null,
    });

    const v2 = decodeNodeEvent(
      encodePayload(NodeEventV2Schema, {
        nodeId: 'n3',
        status: NODE_EVENT_STATUS_ONLINE,
        reach: 'lan',
        inventory: null,
        version: '1.0.0',
        directCapable: true,
        name: 'n3',
      })
    );
    expect(v2.transport).toBeNull();
    expect(v2.rttMs).toBeNull();
    expect(v2.version).toBe('1.0.0');

    const v3 = decodeNodeEvent(
      encodeNodeEvent({
        nodeId: 'n4',
        status: NODE_EVENT_STATUS_ONLINE,
        reach: 'wan',
        transport: 'ws-secure',
        rttMs: 12.6,
      })
    );
    expect(v3.transport).toBe('ws-secure');
    expect(v3.rttMs).toBe(13);
  });

  it('RTC_SIGNAL payload roundtrip', () => {
    const offer = decodePayload(
      RtcSignalSchema,
      encodePayload(RtcSignalSchema, {
        rtcSession: 'sess-1',
        from: RTC_SIGNAL_FROM_BROWSER,
        to: 'node-b',
        sdp: 'v=0',
        candidate: null,
      })
    );
    expect(offer.from).toBe(RTC_SIGNAL_FROM_BROWSER);
    expect(offer.sdp).toBe('v=0');
    expect(offer.candidate).toBeNull();

    const ice = decodePayload(
      RtcSignalSchema,
      encodePayload(RtcSignalSchema, {
        rtcSession: 'sess-1',
        from: RTC_SIGNAL_FROM_NODE,
        to: 'node-a',
        sdp: null,
        candidate: 'candidate:1',
      })
    );
    expect(ice.from).toBe(RTC_SIGNAL_FROM_NODE);
    expect(ice.candidate).toBe('candidate:1');
  });

  it('CARRIER_SWITCH / ACK payload roundtrip + envelope', () => {
    const sw = decodePayload(
      CarrierSwitchSchema,
      encodePayload(CarrierSwitchSchema, {
        epoch: 3,
        to: CARRIER_SWITCH_TO_DIRECT,
        rtcSession: 'br:abc',
      })
    );
    expect(sw.epoch).toBe(3);
    expect(sw.to).toBe(CARRIER_SWITCH_TO_DIRECT);
    expect(sw.rtcSession).toBe('br:abc');

    const ackPayload = encodePayload(CarrierSwitchAckSchema, { epoch: 3, rtcSession: 'br:abc' });
    const envelope = encodeEnvelope(KIND_CARRIER_SWITCH_ACK, ackPayload, 9);
    const decodedEnv = decodeEnvelope(envelope);
    expect(decodedEnv.kind).toBe(KIND_CARRIER_SWITCH_ACK);
    const ack = decodePayload(CarrierSwitchAckSchema, decodedEnv.payload);
    expect(ack.epoch).toBe(3);
    expect(ack.rtcSession).toBe('br:abc');
    expect(CARRIER_SWITCH_TO_PRIMARY).toBe(1);

    // 老 node 不带 session：空串同样可编解码，接收方按宽容规则处理
    const legacy = decodePayload(
      CarrierSwitchSchema,
      encodePayload(CarrierSwitchSchema, {
        epoch: 4,
        to: CARRIER_SWITCH_TO_PRIMARY,
        rtcSession: '',
      })
    );
    expect(legacy.rtcSession).toBe('');
  });

  it('ENROLL_REDEEMED payload roundtrip + envelope', () => {
    const data = {
      enrollPk: new Uint8Array(32).fill(1),
      certificate: new Uint8Array([9, 8, 7]),
      certSig: new Uint8Array(64).fill(2),
      nodeId: 'aa'.repeat(16),
    };
    const decoded = decodePayload(EnrollRedeemedSchema, encodePayload(EnrollRedeemedSchema, data));
    expect(decoded.enrollPk).toEqual(data.enrollPk);
    expect(decoded.certificate).toEqual(data.certificate);
    expect(decoded.certSig).toEqual(data.certSig);
    expect(decoded.nodeId).toBe(data.nodeId);

    const frame = encodeEnvelope(
      KIND_ENROLL_REDEEMED,
      encodePayload(EnrollRedeemedSchema, data),
      4
    );
    expect(decodeEnvelope(frame).kind).toBe(KIND_ENROLL_REDEEMED);
  });

  it('ENROLL_REDEEMED 拒绝错误长度的 enrollPk/certSig 与过长证书', () => {
    const good = {
      enrollPk: new Uint8Array(32).fill(1),
      certificate: new Uint8Array([9, 8, 7]),
      certSig: new Uint8Array(64).fill(2),
      nodeId: 'aa'.repeat(16),
    };
    assertEnrollRedeemedFields(good);
    expect(() =>
      encodePayload(EnrollRedeemedSchema, { ...good, enrollPk: new Uint8Array(16) })
    ).toThrow(/Bytes length mismatch/);
    expect(() =>
      encodePayload(EnrollRedeemedSchema, { ...good, certSig: new Uint8Array(32) })
    ).toThrow(/Bytes length mismatch/);
    expect(() =>
      assertEnrollRedeemedFields({
        ...good,
        certificate: new Uint8Array(ENROLL_REDEEMED_MAX_CERT_BYTES + 1),
      })
    ).toThrow(/certificate too large/);
    expect(() => assertEnrollRedeemedFields({ ...good, nodeId: 'not-hex' })).toThrow(/32-hex/);
  });
});
