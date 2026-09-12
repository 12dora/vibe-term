import { describe, expect, test } from 'bun:test';
import { parsePortReachList } from '../port-reach';

describe('probe 回包解析', () => {
  test('探测结果走同一套解析：畸形条目丢掉，合法条目留下', () => {
    expect(
      parsePortReachList([
        { purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'open' },
        { purpose: 'rtc-ice', proto: 'udp', status: 'nope' },
      ])
    ).toEqual([{ purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'open' }]);
  });
});
