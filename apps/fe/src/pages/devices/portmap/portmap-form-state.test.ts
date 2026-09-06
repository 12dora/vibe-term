import { describe, expect, test } from 'bun:test';
import {
  LISTEN_HOST_ANY,
  LISTEN_HOST_LOCAL,
  createPortMapFormState,
  listenProbeBlock,
  parsePort,
  portMapSubmitBlock,
  probeTarget,
  resetFormIfUnchanged,
  targetProbeHint,
  validatePortMapForm,
} from './portmap-form-state';

function form(overrides: Partial<ReturnType<typeof createPortMapFormState>> = {}) {
  return {
    ...createPortMapFormState('self'),
    listenPort: '8080',
    targetNodeId: 'bb',
    targetPort: '5432',
    ...overrides,
  };
}

describe('parsePort', () => {
  test('只接受 1–65535 的整数', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort(' 65535 ')).toBe(65535);
    expect(parsePort('0')).toBeNull();
    expect(parsePort('65536')).toBeNull();
    expect(parsePort('')).toBeNull();
    expect(parsePort('80a')).toBeNull();
    expect(parsePort('8.0')).toBeNull();
    expect(parsePort('-1')).toBeNull();
  });
});

describe('createPortMapFormState', () => {
  test('两侧地址默认 127.0.0.1', () => {
    const state = createPortMapFormState('self');
    expect(state.listenHost).toBe(LISTEN_HOST_LOCAL);
    expect(state.targetHost).toBe(LISTEN_HOST_LOCAL);
    expect(state.listenNodeId).toBe('self');
    expect(state.targetNodeId).toBeNull();
  });
});

describe('validatePortMapForm', () => {
  test('空端口不算错，非法端口才报', () => {
    expect(validatePortMapForm(form({ listenPort: '', targetPort: '' }))).toEqual({});
    expect(validatePortMapForm(form({ listenPort: '99999' }))).toEqual({ listenPort: 'range' });
    expect(validatePortMapForm(form({ targetPort: 'x' }))).toEqual({ targetPort: 'range' });
  });
});

describe('探测结果', () => {
  test('保留端口优先于占用，空闲则不阻断', () => {
    expect(listenProbeBlock(null)).toBeNull();
    expect(
      listenProbeBlock({ host: 'h', port: 22, free: false, reserved: true, usedByMapId: null })
    ).toBe('reserved');
    expect(
      listenProbeBlock({ host: 'h', port: 80, free: false, reserved: false, usedByMapId: 'm1' })
    ).toBe('inUse');
    expect(
      listenProbeBlock({ host: 'h', port: 80, free: true, reserved: false, usedByMapId: null })
    ).toBeNull();
  });

  test('目标端口无服务只给提示', () => {
    expect(targetProbeHint(null)).toBeNull();
    expect(targetProbeHint({ host: 'h', port: 1, listening: true })).toBeNull();
    expect(targetProbeHint({ host: 'h', port: 1, listening: false })).toBe('idle');
  });

  test('探测参数不全时不发请求', () => {
    expect(probeTarget(null, '127.0.0.1', '80')).toBeNull();
    expect(probeTarget('self', '', '80')).toBeNull();
    expect(probeTarget('self', '127.0.0.1', '')).toBeNull();
    expect(probeTarget('self', ' 127.0.0.1 ', '80')).toEqual({
      nodeId: 'self',
      host: '127.0.0.1',
      port: 80,
    });
  });
});

describe('portMapSubmitBlock', () => {
  test('填全且端口空闲时可提交', () => {
    expect(
      portMapSubmitBlock(form(), {
        host: '127.0.0.1',
        port: 8080,
        free: true,
        reserved: false,
        usedByMapId: null,
      })
    ).toBeNull();
  });

  test('探测还没回来也允许提交（后端仍会 409 兜底）', () => {
    expect(portMapSubmitBlock(form(), null)).toBeNull();
  });

  test('端口非法 / 缺字段 / 同节点 / 端口被占各自阻断', () => {
    expect(portMapSubmitBlock(form({ listenPort: '99999' }), null)).toBe('invalidPort');
    expect(portMapSubmitBlock(form({ targetPort: '' }), null)).toBe('incomplete');
    expect(portMapSubmitBlock(form({ targetNodeId: null }), null)).toBe('incomplete');
    expect(portMapSubmitBlock(form({ targetNodeId: 'self' }), null)).toBe('sameNode');
    expect(
      portMapSubmitBlock(form(), {
        host: '127.0.0.1',
        port: 8080,
        free: false,
        reserved: false,
        usedByMapId: null,
      })
    ).toBe('portTaken');
  });

  test('监听所有地址不影响提交条件', () => {
    expect(portMapSubmitBlock(form({ listenHost: LISTEN_HOST_ANY }), null)).toBeNull();
  });
});

describe('resetFormIfUnchanged', () => {
  test('表单没动过时按新的监听节点重置', () => {
    const submitted = form();
    const next = resetFormIfUnchanged(submitted, 'self')(submitted);
    expect(next).toEqual(createPortMapFormState('self'));
  });

  test('提交后又改过的表单不被迟到的响应覆盖', () => {
    const submitted = form();
    const edited = { ...submitted, targetPort: '6379' };
    expect(resetFormIfUnchanged(submitted, 'self')(edited)).toBe(edited);
  });
});
