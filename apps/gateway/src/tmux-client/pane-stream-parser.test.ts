import { describe, expect, test } from 'bun:test';

import { createPaneStreamParser } from './pane-stream-parser';

type NotificationRecord = {
  source: 'osc9' | 'osc99' | 'osc777' | 'osc1337';
  title?: string;
  body: string;
};

const encoder = new TextEncoder();

function bytes(...parts: Array<number | string | Uint8Array>): Uint8Array {
  const output: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') {
      output.push(part);
      continue;
    }
    if (typeof part === 'string') {
      output.push(...encoder.encode(part));
      continue;
    }
    output.push(...part);
  }
  return new Uint8Array(output);
}

describe('pane stream parser - OSC 133 prompt markers', () => {
  function collectMarkers() {
    const markers: Array<{ kind: string; exitCode: number | null; params: string[] }> = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification: () => {},
      onPromptMarker: (marker) => markers.push(marker),
    });
    return { parser, markers };
  }

  const ST = bytes(0x1b, 0x5c);

  test('C 输出开始（ST 结尾）从输出剥离并上抛', () => {
    const { parser, markers } = collectMarkers();
    const output = parser.push(bytes('X', 0x1b, ']', '133;C', ST, 'Y'));
    expect(Array.from(output)).toEqual([0x58, 0x59]);
    expect(markers).toEqual([{ kind: 'C', exitCode: null, params: [] }]);
  });

  test('D 命令结束带退出码', () => {
    const { parser, markers } = collectMarkers();
    parser.push(bytes(0x1b, ']', '133;D;0', ST));
    parser.push(bytes(0x1b, ']', '133;D;1', 0x07));
    expect(markers).toEqual([
      { kind: 'D', exitCode: 0, params: ['0'] },
      { kind: 'D', exitCode: 1, params: ['1'] },
    ]);
  });

  test('D 带 nonce 参数', () => {
    const { parser, markers } = collectMarkers();
    parser.push(bytes(0x1b, ']', '133;D;137;tmex=abc123', ST));
    expect(markers[0]).toEqual({ kind: 'D', exitCode: 137, params: ['137', 'tmex=abc123'] });
  });

  test('A/B 提示符标记', () => {
    const { parser, markers } = collectMarkers();
    parser.push(bytes(0x1b, ']', '133;A', ST, 0x1b, ']', '133;B', ST));
    expect(markers.map((m) => m.kind)).toEqual(['A', 'B']);
  });

  test('tmux passthrough 包裹的 OSC 133 也能解析', () => {
    const { parser, markers } = collectMarkers();
    // 外层 DCS：ESC P tmux ; <body> ESC \；body 内每个 ESC 都被加倍（1b 1b）。
    // 内层目标序列 = ESC ] 133;D;0 ESC \  →  body = 1b1b 5d 133;D;0 1b1b 5c
    parser.push(bytes(0x1b, 'Ptmux;', 0x1b, 0x1b, 0x5d, '133;D;0', 0x1b, 0x1b, 0x5c, 0x1b, 0x5c));
    expect(markers).toEqual([{ kind: 'D', exitCode: 0, params: ['0'] }]);
  });

  test('未知子命令忽略', () => {
    const { parser, markers } = collectMarkers();
    parser.push(bytes(0x1b, ']', '133;Z', ST));
    expect(markers).toEqual([]);
  });
});

describe('pane stream parser', () => {
  test('emits bare BEL as bell and removes it from output', () => {
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell() {
        bells.push(1);
      },
      onNotification: () => {},
    });

    const output = parser.push(bytes('A', 0x07, 'B'));

    expect(Array.from(output)).toEqual([0x41, 0x42]);
    expect(bells).toEqual([1]);
  });

  test('emits title change for OSC 2 terminated by BEL without emitting bell', () => {
    const titles: string[] = [];
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle(title: string) {
        titles.push(title);
      },
      onBell() {
        bells.push(1);
      },
      onNotification: () => {},
    });

    const output = parser.push(bytes(0x1b, 0x5d, '2;dev', 0x07));

    expect(Array.from(output)).toEqual([]);
    expect(titles).toEqual(['dev']);
    expect(bells).toEqual([]);
  });

  test('emits title change for OSC 0 terminated by ST and preserves surrounding bytes', () => {
    const titles: string[] = [];
    const parser = createPaneStreamParser({
      onTitle(title: string) {
        titles.push(title);
      },
      onBell: () => {},
      onNotification: () => {},
    });

    const output = parser.push(bytes('A', 0x1b, 0x5d, '0;中', 0x1b, 0x5c, 'B'));

    expect(Array.from(output)).toEqual([0x41, 0x42]);
    expect(titles).toEqual(['中']);
  });

  test('consumes screen title sequences without leaking text or emitting bell', () => {
    const titles: string[] = [];
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle(title: string) {
        titles.push(title);
      },
      onBell() {
        bells.push(1);
      },
      onNotification: () => {},
    });

    const output = parser.push(bytes(0x1b, 0x6b, 'echo', 0x07, 'test\r\n'));

    expect(Array.from(output)).toEqual(Array.from(bytes('test\r\n')));
    expect(titles).toEqual(['echo']);
    expect(bells).toEqual([]);
  });

  test('emits OSC 9 notification and ignores OSC 9 progress payloads', () => {
    const notifications: NotificationRecord[] = [];
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell() {
        bells.push(1);
      },
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const output = parser.push(
      bytes('A', 0x1b, 0x5d, '9;hello from tmex', 0x07, 'B', 0x1b, 0x5d, '9;4;1;42', 0x07, 'C')
    );

    expect(Array.from(output)).toEqual(Array.from(bytes('ABC')));
    expect(notifications).toEqual([{ source: 'osc9', body: 'hello from tmex' }]);
    expect(bells).toEqual([]);
  });

  test('emits OSC 777 notification and keeps semicolons in body', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    parser.push(bytes(0x1b, 0x5d, '777;notify;Build finished;All 42 tests;passed', 0x07));

    expect(notifications).toEqual([
      {
        source: 'osc777',
        title: 'Build finished',
        body: 'All 42 tests;passed',
      },
    ]);
  });

  test('emits OSC 1337 RequestAttention only for matching subcommands', () => {
    const notifications: NotificationRecord[] = [];
    const outputParser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const output = outputParser.push(
      bytes(
        'A',
        0x1b,
        0x5d,
        '1337;RequestAttention=yes',
        0x07,
        'B',
        0x1b,
        0x5d,
        '1337;SetMark',
        0x07,
        'C'
      )
    );

    expect(Array.from(output)).toEqual(Array.from(bytes('ABC')));
    expect(notifications).toEqual([{ source: 'osc1337', body: 'RequestAttention' }]);
  });

  test('keeps parser state across push calls for OSC notifications terminated by ST', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const out1 = parser.push(bytes(0x1b, 0x5d, '777;notify;Build'));
    const out2 = parser.push(bytes(' finished;OK', 0x1b, 0x5c, 'X'));

    expect(Array.from(out1)).toEqual([]);
    expect(Array.from(out2)).toEqual([0x58]);
    expect(notifications).toEqual([
      {
        source: 'osc777',
        title: 'Build finished',
        body: 'OK',
      },
    ]);
  });

  test('swallows unknown OSC sequences without leaking bytes', () => {
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification: () => {},
    });

    const output = parser.push(bytes('A', 0x1b, 0x5d, '999;secret', 0x07, 'B'));

    expect(Array.from(output)).toEqual(Array.from(bytes('AB')));
  });

  test('emits notification when OSC 777 follows echoed shell command text', () => {
    const notifications: NotificationRecord[] = [];
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell() {
        bells.push(1);
      },
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const output = parser.push(
      bytes(
        "sh-3.2$ printf $'\\033]777;notify;Build finished;OK\\007'\r\n",
        0x1b,
        0x5d,
        '777;notify;Build finished;OK',
        0x07,
        'sh-3.2$ '
      )
    );

    expect(new TextDecoder().decode(output)).toBe(
      "sh-3.2$ printf $'\\033]777;notify;Build finished;OK\\007'\r\nsh-3.2$ "
    );
    expect(notifications).toEqual([
      {
        source: 'osc777',
        title: 'Build finished',
        body: 'OK',
      },
    ]);
    expect(bells).toEqual([]);
  });

  test('unwraps tmux passthrough wrapped OSC 9 notification (Claude Code in tmux)', () => {
    const notifications: NotificationRecord[] = [];
    const bells: number[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell() {
        bells.push(1);
      },
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    // \x1bPtmux;\x1b\x1b]9;task done\x07\x1b\\ —— 内层 ESC 翻倍，BEL 终结内层 OSC
    const output = parser.push(
      bytes('A', 0x1b, 'Ptmux;', 0x1b, 0x1b, ']9;task done', 0x07, 0x1b, 0x5c, 'B')
    );

    expect(Array.from(output)).toEqual(Array.from(bytes('AB')));
    expect(notifications).toEqual([{ source: 'osc9', body: 'task done' }]);
    expect(bells).toEqual([]);
  });

  test('unwraps tmux passthrough wrapped OSC 777 with ST terminator split across pushes', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    // 内层 OSC 777 用 ST 终结：包装后为 ESC ESC ] ... ESC ESC \ + 外层 ESC \
    const wrapped = bytes(
      0x1b,
      'Ptmux;',
      0x1b,
      0x1b,
      ']777;notify;Claude;done',
      0x1b,
      0x1b,
      0x5c,
      0x1b,
      0x5c
    );
    parser.push(wrapped.slice(0, 12));
    parser.push(wrapped.slice(12));

    expect(notifications).toEqual([{ source: 'osc777', title: 'Claude', body: 'done' }]);
  });

  test('aggregates kitty OSC 99 notification fragments by id (Claude Code kitty channel)', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const output = parser.push(
      bytes(
        0x1b,
        0x5d,
        '99;i=42:d=0:p=title;Claude Code',
        0x1b,
        0x5c,
        0x1b,
        0x5d,
        '99;i=42:p=body;Task finished',
        0x1b,
        0x5c,
        0x1b,
        0x5d,
        '99;i=42:d=1:a=focus;',
        0x1b,
        0x5c,
        'Z'
      )
    );

    expect(Array.from(output)).toEqual(Array.from(bytes('Z')));
    expect(notifications).toEqual([
      { source: 'osc99', title: 'Claude Code', body: 'Task finished' },
    ]);
  });

  test('passes through non-tmux DCS sequences unchanged', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    const dcs = bytes('A', 0x1b, 'P+q544e', 0x1b, 0x5c, 'B');
    const output = parser.push(dcs);

    expect(Array.from(output)).toEqual(Array.from(dcs));
    expect(notifications).toEqual([]);
  });

  test('keeps OSC body intact when payload contains ESC followed by regular bytes', () => {
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification(notification: NotificationRecord) {
        notifications.push(notification);
      },
    });

    // payload 中混入 ESC x：应保留并回到 body 状态，由 BEL 正常终结
    const output = parser.push(bytes(0x1b, 0x5d, '9;ab', 0x1b, 'xcd', 0x07, 'Z'));

    expect(Array.from(output)).toEqual(Array.from(bytes('Z')));
    expect(notifications).toEqual([{ source: 'osc9', body: 'ab\u001bxcd' }]);
  });
});

describe('pane stream parser - OSC 52 clipboard', () => {
  function collectClipboard() {
    const writes: string[] = [];
    const clock = { now: 0 };
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification: () => {},
      onClipboardWrite: (text) => writes.push(text),
      now: () => clock.now,
    });
    return { parser, writes, clock };
  }

  const ST = bytes(0x1b, 0x5c);

  test('basic write with BEL terminator', () => {
    const { parser, writes } = collectClipboard();
    // "hello" -> base64 "aGVsbG8="
    const output = parser.push(bytes('X', 0x1b, ']', '52;c;aGVsbG8=', 0x07, 'Y'));
    expect(Array.from(output)).toEqual([0x58, 0x59]);
    expect(writes).toEqual(['hello']);
  });

  test('basic write with ST terminator', () => {
    const { parser, writes } = collectClipboard();
    const output = parser.push(bytes('X', 0x1b, ']', '52;c;aGVsbG8=', ST, 'Y'));
    expect(Array.from(output)).toEqual([0x58, 0x59]);
    expect(writes).toEqual(['hello']);
  });

  test('read request (?) is silently discarded', () => {
    const { parser, writes } = collectClipboard();
    const output = parser.push(bytes(0x1b, ']', '52;c;?', 0x07, 'Z'));
    expect(Array.from(output)).toEqual([0x5a]);
    expect(writes).toEqual([]);
  });

  test('invalid base64 is silently discarded', () => {
    const { parser, writes } = collectClipboard();
    const output = parser.push(bytes(0x1b, ']', '52;c;%%%invalid', 0x07, 'Z'));
    expect(Array.from(output)).toEqual([0x5a]);
    expect(writes).toEqual([]);
  });

  test('empty base64 payload is discarded', () => {
    const { parser, writes } = collectClipboard();
    const output = parser.push(bytes(0x1b, ']', '52;c;', 0x07, 'Z'));
    expect(Array.from(output)).toEqual([0x5a]);
    expect(writes).toEqual([]);
  });

  test('primary selection parameter (s)', () => {
    const { parser, writes } = collectClipboard();
    parser.push(bytes(0x1b, ']', '52;s;aGVsbG8=', 0x07));
    expect(writes).toEqual(['hello']);
  });

  test('multiple selection parameters (pc)', () => {
    const { parser, writes } = collectClipboard();
    parser.push(bytes(0x1b, ']', '52;pc;aGVsbG8=', 0x07));
    expect(writes).toEqual(['hello']);
  });

  // pane 内编辑器（nvim `clipboard=unnamed,unnamedplus`，内置 OSC 52 provider 把 `*` 映到 p、
  // `+` 映到 c）双击选词或拖拽选择时，一次复制会连发 primary + clipboard 两条 OSC 52。
  // 两条都当剪贴板写就是「写两次剪贴板、弹两条已复制提示」。
  test('primary + clipboard pair from a single copy writes the clipboard once', () => {
    const { parser, writes } = collectClipboard();
    parser.push(bytes(0x1b, ']', '52;p;aGVsbG8=', 0x07, 0x1b, ']', '52;c;aGVsbG8=', 0x07));
    expect(writes).toEqual(['hello']);
  });

  // Claude Code 的 TUI 一次拖选/双击会连发两条相同的 OSC 52;c（实测 pipe-pane），
  // 各转发一次就是两条「已复制」提示。
  test('identical clipboard writes within the dedup window are forwarded once', () => {
    const { parser, writes, clock } = collectClipboard();
    parser.push(bytes(0x1b, ']', '52;c;aGVsbG8=', 0x07, 0x1b, ']', '52;c;aGVsbG8=', 0x07));
    expect(writes).toEqual(['hello']);
    clock.now = 100;
    parser.push(bytes(0x1b, ']', '52;c;d29ybGQ=', 0x07));
    expect(writes).toEqual(['hello', 'world']);
    clock.now = 1000;
    parser.push(bytes(0x1b, ']', '52;c;d29ybGQ=', 0x07));
    expect(writes).toEqual(['hello', 'world', 'world']);
  });

  test('primary-only writes are ignored', () => {
    const { parser, writes } = collectClipboard();
    const output = parser.push(bytes('X', 0x1b, ']', '52;p;aGVsbG8=', 0x07, 'Y'));
    expect(Array.from(output)).toEqual([0x58, 0x59]);
    expect(writes).toEqual([]);
  });

  test('tmux passthrough wrapped OSC 52', () => {
    const { parser, writes } = collectClipboard();
    // DCS tmux; ESC ESC ] 52;c;aGVsbG8= BEL ESC \
    const output = parser.push(
      bytes(0x1b, 'Ptmux;', 0x1b, 0x1b, ']52;c;aGVsbG8=', 0x07, 0x1b, 0x5c, 'Z')
    );
    expect(Array.from(output)).toEqual([0x5a]);
    expect(writes).toEqual(['hello']);
  });

  test('cross-push split OSC 52 sequence', () => {
    const { parser, writes } = collectClipboard();
    const out1 = parser.push(bytes(0x1b, ']', '52;c;aGVs'));
    const out2 = parser.push(bytes('bG8=', 0x07, 'Z'));
    expect(Array.from(out1)).toEqual([]);
    expect(Array.from(out2)).toEqual([0x5a]);
    expect(writes).toEqual(['hello']);
  });

  test('oversized payload is dropped', () => {
    const { parser, writes } = collectClipboard();
    // MAX_OSC_PAYLOAD_BYTES = 8KB; generate > 8KB of base64 data
    const largeBase64 = 'A'.repeat(9000);
    const output = parser.push(bytes(0x1b, ']', '52;c;', largeBase64, 0x07, 'Z'));
    expect(Array.from(output)).toEqual([0x5a]);
    expect(writes).toEqual([]);
  });

  test('OSC 52 interleaved with other OSC types', () => {
    const titles: string[] = [];
    const writes: string[] = [];
    const parser = createPaneStreamParser({
      onTitle: (title) => titles.push(title),
      onBell: () => {},
      onNotification: () => {},
      onClipboardWrite: (text) => writes.push(text),
    });

    const output = parser.push(
      bytes(
        'A',
        0x1b,
        ']',
        '2;my-title',
        0x07,
        'B',
        0x1b,
        ']',
        '52;c;aGVsbG8=',
        0x07,
        'C',
        0x1b,
        ']',
        '2;title2',
        0x07,
        'D'
      )
    );

    expect(new TextDecoder().decode(output)).toBe('ABCD');
    expect(titles).toEqual(['my-title', 'title2']);
    expect(writes).toEqual(['hello']);
  });
});

describe('pane stream parser - CSI mode 2031 主题订阅', () => {
  function collectSubscriptions() {
    const subs: boolean[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification: () => {},
      onThemeSubscription: (subscribed) => subs.push(subscribed),
    });
    return { parser, subs };
  }

  test('?2031h/?2031l 上报订阅状态且字节原样透传', () => {
    const { parser, subs } = collectSubscriptions();
    const input = bytes('X', 0x1b, '[?2031h', 'Y', 0x1b, '[?2031l', 'Z');
    const output = parser.push(input);
    expect(Array.from(output)).toEqual(Array.from(input));
    expect(subs).toEqual([true, false]);
  });

  test('多参数合并声明 ?1004;2031h 也识别', () => {
    const { parser, subs } = collectSubscriptions();
    const input = bytes(0x1b, '[?1004;2031h');
    const output = parser.push(input);
    expect(Array.from(output)).toEqual(Array.from(input));
    expect(subs).toEqual([true]);
  });

  test('无关 CSI 不上报且原样透传（SGR/光标移动/其他 private mode）', () => {
    const { parser, subs } = collectSubscriptions();
    const input = bytes(0x1b, '[1;31m', 0x1b, '[2J', 0x1b, '[?1004h', 0x1b, '[?20316h');
    const output = parser.push(input);
    expect(Array.from(output)).toEqual(Array.from(input));
    expect(subs).toEqual([]);
  });

  test('跨 push 分片的 ?2031h 仍识别', () => {
    const { parser, subs } = collectSubscriptions();
    const out1 = parser.push(bytes('A', 0x1b, '[?20'));
    const out2 = parser.push(bytes('31h', 'B'));
    expect(Array.from(out1)).toEqual([0x41]);
    expect(Array.from(out2)).toEqual(Array.from(bytes(0x1b, '[?2031h', 'B')));
    expect(subs).toEqual([true]);
  });

  test('tmux passthrough 包裹的 ?2031h 不上报但字节照常透传', () => {
    const { parser, subs } = collectSubscriptions();
    // ESC P tmux ; ESC ESC [?2031h ESC \（body 内 ESC 加倍）
    const input = bytes(0x1b, 'Ptmux;', 0x1b, 0x1b, '[?2031h', 0x1b, 0x5c);
    const output = parser.push(input);
    expect(Array.from(output)).toEqual(Array.from(bytes(0x1b, '[?2031h')));
    expect(subs).toEqual([]);
  });

  test('超长 CSI 放弃解析并原样回填', () => {
    const { parser, subs } = collectSubscriptions();
    const longParams = '9'.repeat(80);
    const input = bytes(0x1b, '[', longParams, 'm');
    const output = parser.push(input);
    expect(Array.from(output)).toEqual(Array.from(input));
    expect(subs).toEqual([]);
  });

  test('CSI 内出现 ESC 中止解析并开启新序列', () => {
    const { parser, subs } = collectSubscriptions();
    const output = parser.push(bytes(0x1b, '[?20', 0x1b, '[?2031h'));
    expect(Array.from(output)).toEqual(Array.from(bytes(0x1b, '[?20', 0x1b, '[?2031h')));
    expect(subs).toEqual([true]);
  });
});

describe('pane stream parser - bounded realtime metadata', () => {
  test('extracts OSC 7 current directory without leaking escape bytes', () => {
    const paths: string[] = [];
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onCurrentPath: (value) => paths.push(value),
      onBell: () => {},
      onNotification: () => {},
    });
    const output = parser.push(bytes('A', 0x1b, ']7;file://host/work/my%20repo', 0x07, 'B'));
    expect(new TextDecoder().decode(output)).toBe('AB');
    expect(paths).toEqual(['/work/my repo']);
  });

  test('drops an oversized ESC-k title with bounded memory and resumes parsing', () => {
    const titles: string[] = [];
    const parser = createPaneStreamParser({
      onTitle: (value) => titles.push(value),
      onBell: () => {},
      onNotification: () => {},
    });
    const output = parser.push(bytes(0x1b, 'k', 'x'.repeat(9 * 1024), 0x07, 'ok'));
    expect(titles).toEqual([]);
    expect(new TextDecoder().decode(output)).toBe('ok');
  });
});

describe('pane stream parser - chunk splits inside escapes', () => {
  function collect() {
    const titles: string[] = [];
    const notifications: NotificationRecord[] = [];
    const parser = createPaneStreamParser({
      onTitle: (title) => titles.push(title),
      onBell: () => {},
      onNotification: (notification) => notifications.push(notification),
    });
    return { parser, titles, notifications };
  }

  test('split after ESC still starts OSC and strips it', () => {
    const { parser, titles } = collect();
    const out1 = parser.push(bytes('A', 0x1b));
    const out2 = parser.push(bytes(']2;dev', 0x07, 'B'));
    expect(Array.from(out1)).toEqual([0x41]);
    expect(Array.from(out2)).toEqual([0x42]);
    expect(titles).toEqual(['dev']);
  });

  test('split inside CSI params then final byte', () => {
    const { parser } = collect();
    const out1 = parser.push(bytes('X', 0x1b, '[1;3'));
    const out2 = parser.push(bytes('1mY'));
    expect(Array.from(out1)).toEqual([0x58]);
    expect(Array.from(out2)).toEqual(Array.from(bytes(0x1b, '[1;31mY')));
  });

  test('split inside DCS tmux prefix', () => {
    const { parser, notifications } = collect();
    const wrapped = bytes(0x1b, 'Ptmux;', 0x1b, 0x1b, ']9;task', 0x07, 0x1b, 0x5c, 'Z');
    const splitAt = 4;
    const out1 = parser.push(wrapped.subarray(0, splitAt));
    const out2 = parser.push(wrapped.subarray(splitAt));
    expect(Array.from(out1)).toEqual([]);
    expect(Array.from(out2)).toEqual([0x5a]);
    expect(notifications).toEqual([{ source: 'osc9', body: 'task' }]);
  });

  test('split between doubled ESC inside passthrough body', () => {
    const { parser, notifications } = collect();
    const wrapped = bytes(0x1b, 'Ptmux;', 0x1b, 0x1b, ']9;ok', 0x07, 0x1b, 0x5c);
    const splitAt = wrapped.indexOf(0x1b, 2) + 1;
    parser.push(wrapped.subarray(0, splitAt));
    parser.push(wrapped.subarray(splitAt));
    expect(notifications).toEqual([{ source: 'osc9', body: 'ok' }]);
  });

  test('passthrough ending on incomplete CSI then following text', () => {
    const { parser } = collect();
    const inner = bytes(0x1b, '[?20');
    const wrapped = bytes(0x1b, 'Ptmux;', 0x1b, 0x1b, '[?20', 0x1b, 0x5c, 'Z');
    const output = parser.push(wrapped);
    expect(Array.from(output)).toEqual(Array.from(bytes(inner, 'Z')));
  });
});

describe('pane stream parser - reusable push frames', () => {
  test('materialized output remains owned after the frame is reused', () => {
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification: () => {},
    });
    const first = parser.push(bytes('first'));
    expect(new TextDecoder().decode(parser.push(bytes('second')))).toBe('second');
    expect(new TextDecoder().decode(first)).toBe('first');
  });

  test('a callback can re-enter push without corrupting either output buffer', () => {
    let nestedOutput: Uint8Array = new Uint8Array();
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {
        nestedOutput = parser.push(bytes('nested'));
      },
      onNotification: () => {},
    });

    const outerOutput = parser.push(bytes('A', 0x07, 'B'));
    expect(new TextDecoder().decode(outerOutput)).toBe('AB');
    expect(new TextDecoder().decode(nestedOutput)).toBe('nested');
  });

  test('materializing after a notifications-only partial CSI preserves parser state', () => {
    const parser = createPaneStreamParser({
      onTitle: () => {},
      onBell: () => {},
      onNotification: () => {},
    });

    expect(parser.push(bytes(0x1b, '[1;3'), false)).toHaveLength(0);
    expect(Array.from(parser.push(bytes('1mX'), true))).toEqual(Array.from(bytes(0x1b, '[1;31mX')));
  });
});
