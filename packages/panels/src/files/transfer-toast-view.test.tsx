import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { BatchProgress } from './transfer-progress';
import { ToastBody } from './transfer-toast-view';

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}${JSON.stringify(opts)}` : key) as unknown as TFunction;

function render(progress: BatchProgress, title: string, ratePerSec = 0): string {
  const model = { title, view: progress.view(), ratePerSec };
  return renderToStaticMarkup(<ToastBody model={model} t={t} />);
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('ToastBody 单个条目', () => {
  test('只有一条进度条，没有分段行；显示文件名、路径徽标与阶段', () => {
    const progress = new BatchProgress('download', [{ name: 'big.iso', size: 2048 }]);
    progress.setStatus(0, 'running');
    progress.weights(0, [0, 1]);
    progress.leg(0, 2, { pct: 50, bytes: 1024, totalBytes: 2048 });
    progress.setPath('relay');

    const html = render(progress, 'big.iso', 1024);
    expect(html).toContain('big.iso');
    expect(html).toContain('files.transfer.pathRelay');
    expect(html).toContain('files.transfer.stage.transferring');
    expect(html).toContain('1.0 KB/s');
    expect(html).toContain('1.0 KB / 2.0 KB');
    expect(html).not.toContain('files.transfer.leg');
    expect(count(html, 'bg-primary')).toBe(1);
    expect(html).toContain('width:50%');
  });

  test('没有速率时不占位，未知大小时不显示字节明细', () => {
    const progress = new BatchProgress('upload', [{ name: 'a', size: 0 }]);
    progress.setStatus(0, 'running');
    const html = render(progress, 'a');
    expect(html).not.toContain('KB/s');
    expect(html).not.toContain(' / ');
    expect(html).toContain('files.transfer.stage.preparing');
  });
});

describe('ToastBody 批量', () => {
  function batch(): BatchProgress {
    const progress = new BatchProgress('upload', [
      { name: 'one.txt', size: 100 },
      { name: 'two.txt', size: 100 },
      { name: 'three.txt', size: 100 },
    ]);
    progress.setStatus(0, 'done');
    progress.setStatus(1, 'running');
    progress.weights(1, [1, 0]);
    progress.leg(1, 1, { pct: 50, bytes: 50, totalBytes: 100 });
    return progress;
  }

  test('总览：批标题、完成计数、总览条与逐条列表（已完成的不再列出）', () => {
    const html = render(batch(), 'files.transfer.uploadBatch{"count":3}', 2048);
    expect(html).toContain('files.transfer.uploadBatch{&quot;count&quot;:3}');
    expect(html).toContain('files.transfer.batchProgress{&quot;done&quot;:1,&quot;total&quot;:3}');
    expect(count(html, 'data-testid="transfer-item"')).toBe(2);
    expect(html).not.toContain('one.txt');
    expect(html).toContain('two.txt');
    expect(html).toContain('three.txt');
    expect(html).toContain('2.0 KB/s');
  });

  test('列表行：传输中显示百分比，其它阶段显示阶段名', () => {
    const html = render(batch(), 'title');
    expect(html).toContain('50%');
    expect(html).toContain('files.transfer.stage.queued');
  });

  test('列表区限高可滚动', () => {
    const html = render(batch(), 'title');
    expect(html).toContain('max-h-36');
    expect(html).toContain('overflow-y-auto');
  });
});
