import { describe, expect, test } from 'bun:test';
import type { ShareLogEntry, ShareLogPage } from '@vibeterm/shared/share';
import { InterruptError, UsageError } from './errors';
import type { HttpClient } from './http';
import { REPLAY_TTY_RESTORE } from './replay-vt';
import {
  assembleShareReplay,
  decodeShareLogData,
  fetchShareLogPages,
  formatShareLogLine,
  pickShareReplayPane,
  playShareReplay,
  shareLogDataSize,
  shareLogQueryPath,
} from './share-replay';

const BASE = 1_700_000_000_000;
const HI = Buffer.from('hi', 'utf8').toString('base64');

function entry(partial: Partial<ShareLogEntry> & { seq: number; at: number }): ShareLogEntry {
  return {
    kind: 'out',
    paneId: '%0',
    data: '',
    ...partial,
  };
}

function fakeHttp(pages: ShareLogPage[]): Pick<HttpClient, 'json'> {
  return {
    async json<T>(_nodeId: string, _method: string, path: string): Promise<T> {
      const url = new URL(path, 'http://share.example');
      const after = Number(url.searchParams.get('after') ?? '0');
      const page =
        after === 0
          ? pages[0]
          : (pages.find((item) => item.entries[0]?.seq === after + 1) ?? pages[pages.length - 1]);
      return page as T;
    },
  };
}

describe('decodeShareLogData', () => {
  test('empty string is an empty buffer; utf-8 round-trips like the GUI', () => {
    expect(decodeShareLogData('').length).toBe(0);
    expect(new TextDecoder().decode(decodeShareLogData(HI))).toBe('hi');
    expect(shareLogDataSize(HI)).toBe(2);
    expect(shareLogDataSize('')).toBe(0);
  });
});

describe('formatShareLogLine', () => {
  test('prints ts pane kind size', () => {
    expect(formatShareLogLine(entry({ seq: 1, at: BASE, data: HI }))).toBe(`${BASE} %0 out 2`);
  });
});

describe('shareLogQueryPath', () => {
  test('omits empty query and encodes the id', () => {
    expect(shareLogQueryPath('s-1')).toBe('/api/share/s-1/log');
    expect(shareLogQueryPath('s-1', { after: 4, limit: 2 })).toBe(
      '/api/share/s-1/log?after=4&limit=2'
    );
  });
});

describe('fetchShareLogPages', () => {
  test('--all follows nextAfter across pages and stops', async () => {
    const http = fakeHttp([
      {
        entries: [entry({ seq: 1, at: BASE, data: HI }), entry({ seq: 2, at: BASE + 1, data: HI })],
        nextAfter: 2,
        total: 4,
        truncated: true,
      },
      {
        entries: [
          entry({ seq: 3, at: BASE + 2, data: HI }),
          entry({ seq: 4, at: BASE + 3, data: HI }),
        ],
        nextAfter: null,
        total: 4,
        truncated: true,
      },
    ]);
    const fetched = await fetchShareLogPages(http, 'self', 's-1', { all: true, limit: 2 });
    expect(fetched.entries.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
    expect(fetched.truncated).toBe(true);
    expect(fetched.total).toBe(4);
    expect(fetched.nextAfter).toBeNull();
  });

  test('without --all returns a single page', async () => {
    const http = fakeHttp([
      {
        entries: [entry({ seq: 1, at: BASE, data: HI })],
        nextAfter: 1,
        total: 9,
        truncated: false,
      },
    ]);
    const fetched = await fetchShareLogPages(http, 'self', 's-1', {});
    expect(fetched.entries).toHaveLength(1);
    expect(fetched.nextAfter).toBe(1);
  });
});

describe('pickShareReplayPane', () => {
  const log = [
    entry({ seq: 1, at: BASE, paneId: '%0', data: HI }),
    entry({ seq: 2, at: BASE + 1, paneId: '%1', data: HI }),
  ];

  test('defaults to the first pane in the recording', () => {
    expect(pickShareReplayPane(log, undefined)).toBe('%0');
    expect(pickShareReplayPane([], undefined)).toBeNull();
  });

  test('unknown pane lists the recording panes', () => {
    expect(() => pickShareReplayPane(log, '%9')).toThrow(UsageError);
    try {
      pickShareReplayPane(log, '%9');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toBe('unknown pane: %9');
      expect((error as UsageError).hint).toBe('panes: %0, %1');
    }
  });
});

describe('assembleShareReplay', () => {
  test('groups output chunks per pane and reports duration', () => {
    const assembled = assembleShareReplay([
      entry({ seq: 1, at: BASE, paneId: '%0', kind: 'checkpoint', data: HI, cols: 80, rows: 24 }),
      entry({ seq: 2, at: BASE + 500, paneId: '%0', data: HI }),
      entry({ seq: 3, at: BASE + 1000, paneId: '%1', data: HI, cols: 40, rows: 12 }),
      entry({
        seq: 4,
        at: BASE + 1500,
        paneId: '%0',
        kind: 'resize',
        data: '',
        cols: 100,
        rows: 30,
      }),
      entry({ seq: 5, at: BASE + 2000, paneId: '%0', kind: 'in', data: HI }),
    ]);
    expect(assembled.durationMs).toBe(2000);
    expect(assembled.entries).toBe(5);
    expect(assembled.panes).toEqual([
      { paneId: '%0', cols: 100, rows: 30, chunks: ['hihi'] },
      { paneId: '%1', cols: 40, rows: 12, chunks: ['hi'] },
    ]);
  });

  test('concatenates UTF-8 bytes across chunks before decoding', () => {
    const mid = Buffer.from('中', 'utf8');
    const assembled = assembleShareReplay([
      entry({ seq: 1, at: BASE, data: Buffer.from([mid[0]]).toString('base64') }),
      entry({ seq: 2, at: BASE + 1, data: Buffer.from([mid[1], mid[2]]).toString('base64') }),
    ]);
    expect(assembled.panes[0].chunks).toEqual(['中']);
  });

  test('invalid base64 is a usage error with the entry index', () => {
    expect(() => assembleShareReplay([entry({ seq: 1, at: BASE, data: '!!!' })])).toThrow(
      UsageError
    );
    try {
      assembleShareReplay([
        entry({ seq: 1, at: BASE, data: HI }),
        entry({ seq: 2, at: BASE + 1, data: '!!!' }),
      ]);
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).message).toContain('entry 1');
    }
  });

  test('--from drops earlier chunks but keeps duration', () => {
    const assembled = assembleShareReplay(
      [
        entry({ seq: 1, at: BASE, data: HI }),
        entry({ seq: 2, at: BASE + 800, data: Buffer.from('later').toString('base64') }),
      ],
      500
    );
    expect(assembled.durationMs).toBe(800);
    expect(assembled.panes[0].chunks).toEqual(['later']);
  });
});

describe('playShareReplay', () => {
  test('schedules inter-chunk delays through the injected sleep', async () => {
    const delays: number[] = [];
    const written: string[] = [];
    const notes: string[] = [];
    await playShareReplay(
      [
        entry({ seq: 1, at: BASE, data: HI }),
        entry({ seq: 2, at: BASE + 200, kind: 'in', data: HI }),
        entry({ seq: 3, at: BASE + 1000, kind: 'resize', data: '', cols: 100, rows: 30 }),
        entry({ seq: 4, at: BASE + 2000, data: Buffer.from('xy').toString('base64') }),
      ],
      {
        speed: 2,
        fromMs: 0,
        write: (bytes) => written.push(new TextDecoder().decode(bytes)),
        note: (text) => notes.push(text),
        sleep: async (ms) => {
          delays.push(ms);
        },
        ttySize: { cols: 80, rows: 24 },
      }
    );
    expect(written).toEqual(['hi', 'xy']);
    expect(delays).toEqual([100, 400, 500]);
    expect(notes).toEqual(['pane was 100x30']);
  });

  test('--speed 0 writes immediately and --from skips the prefix', async () => {
    const delays: number[] = [];
    const written: string[] = [];
    await playShareReplay(
      [
        entry({ seq: 1, at: BASE, data: HI }),
        entry({ seq: 2, at: BASE + 400, data: Buffer.from('z').toString('base64') }),
      ],
      {
        speed: 0,
        fromMs: 400,
        write: (bytes) => written.push(new TextDecoder().decode(bytes)),
        note: () => {
          throw new Error('no note');
        },
        sleep: async (ms) => {
          delays.push(ms);
        },
      }
    );
    expect(written).toEqual(['z']);
    expect(delays).toEqual([]);
  });

  test('Ctrl-C restores TTY modes and throws InterruptError', async () => {
    const written: Uint8Array[] = [];
    const controller = new AbortController();
    await expect(
      playShareReplay(
        [entry({ seq: 1, at: BASE, data: HI }), entry({ seq: 2, at: BASE + 50, data: HI })],
        {
          speed: 1,
          fromMs: 0,
          write: (bytes) => written.push(bytes),
          note: () => {},
          sleep: async () => {
            controller.abort();
            throw new InterruptError();
          },
          signal: controller.signal,
        }
      )
    ).rejects.toBeInstanceOf(InterruptError);
    expect(new TextDecoder().decode(written[written.length - 1])).toBe(REPLAY_TTY_RESTORE);
  });

  test('normal end restores TTY when the recording entered alt-screen', async () => {
    const written: string[] = [];
    const alt = Buffer.from('\x1b[?1049hhi', 'utf8').toString('base64');
    await playShareReplay([entry({ seq: 1, at: BASE, data: alt })], {
      speed: 0,
      fromMs: 0,
      write: (bytes) => written.push(new TextDecoder().decode(bytes)),
      note: () => {},
      sleep: async () => {},
    });
    expect(written.at(-1)).toBe(REPLAY_TTY_RESTORE);
    expect(written.join('')).toContain('hi');
    expect(written.join('')).toContain('\x1b[?1049h');
  });

  test('strips OSC 52 before writing to the TTY', async () => {
    const written: string[] = [];
    const payload = Buffer.from('hi\x1b]52;c;QUFBQQ==\x07lo', 'utf8').toString('base64');
    await playShareReplay([entry({ seq: 1, at: BASE, data: payload })], {
      speed: 0,
      fromMs: 0,
      write: (bytes) => written.push(new TextDecoder().decode(bytes)),
      note: () => {},
      sleep: async () => {},
    });
    expect(written.join('')).toBe('hilo');
  });

  test('same-size resize is silent', async () => {
    const notes: string[] = [];
    await playShareReplay(
      [entry({ seq: 1, at: BASE, kind: 'resize', data: '', cols: 80, rows: 24 })],
      {
        speed: 0,
        fromMs: 0,
        write: () => {
          throw new Error('resize writes nothing');
        },
        note: (text) => notes.push(text),
        sleep: async () => {},
        ttySize: { cols: 80, rows: 24 },
      }
    );
    expect(notes).toEqual([]);
  });
});
