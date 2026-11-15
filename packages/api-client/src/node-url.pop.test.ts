import { describe, expect, test } from 'bun:test';
import { popTargetFromUrl } from '@vibeterm/shared/auth';
import { nodeWsUrl, withPopParam } from './node-url';

const NODE = 'c'.repeat(32);

describe('withPopParam', () => {
  test('没有 query 时追加 ?pop=', () => {
    expect(withPopParam('ws://gw.example/ws', 'v1.1.n.s')).toBe('ws://gw.example/ws?pop=v1.1.n.s');
  });

  test('保留原有参数的顺序与编码，pop 排在最后', () => {
    const url = nodeWsUrl(NODE, { protocol: 'https:', host: 'gw.example', cid: 'a b' });
    expect(withPopParam(url, 'p')).toBe(`wss://gw.example/n/${NODE}/ws?cid=a%20b&pop=p`);
  });

  test('已有 pop 被替换而不是叠加', () => {
    expect(withPopParam('ws://gw.example/ws?pop=old&cid=x', 'new')).toBe(
      'ws://gw.example/ws?cid=x&pop=new'
    );
  });

  test('证明里的特殊字符被编码，且不改变签名目标的 query', () => {
    const signed = withPopParam(`ws://gw.example/n/${NODE}/ws?cid=x`, 'v1.1.n.a+b/c=');
    expect(signed).toContain('pop=v1.1.n.a%2Bb%2Fc%3D');
    expect(popTargetFromUrl('GET', signed)).toEqual({ method: 'GET', path: '/ws', query: 'cid=x' });
  });
});
