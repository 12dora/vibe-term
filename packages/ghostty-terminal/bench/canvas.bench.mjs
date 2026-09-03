import { chromium } from '../../../apps/fe/node_modules/@playwright/test/index.mjs';

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  const result = await page.evaluate(async () => {
    const cols = 120;
    const rows = 40;
    const cellWidth = 18;
    const cellHeight = 38;
    const fontSize = 26;
    const width = cols * cellWidth;
    const height = rows * cellHeight;
    const warmups = 30;
    const samples = 120;
    const colors = ['#e8e8e8', '#ff7373', '#7ee787', '#79c0ff'];
    const fonts = [
      `${fontSize}px monospace`,
      `italic ${fontSize}px monospace`,
      `700 ${fontSize}px monospace`,
    ];
    const backgrounds = ['#111111', '#233044', '#40272a'];

    const canvases = Array.from({ length: 7 }, () => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2d canvas context unavailable');
      context.textBaseline = 'alphabetic';
      context.imageSmoothingEnabled = false;
      return { canvas, context };
    });
    const [naive, batched, self, blit, scratch, pingA, pingB] = canvases;

    const cells = Array.from({ length: rows }, (_, row) =>
      Array.from({ length: cols }, (_, col) => {
        const index = row * cols + col;
        const blank = index % 11 === 0 || index % 17 === 0 || index % 29 === 0;
        return {
          text: blank ? '' : String.fromCharCode(33 + ((index * 17) % 90)),
          color: col >= 40 && col < 47 ? colors[1 + (row % 3)] : colors[0],
          font: col >= 80 && col < 98 ? fonts[1 + (row % 2)] : fonts[0],
          background: index % 47 < 3 ? backgrounds[1 + (row % 2)] : backgrounds[0],
        };
      })
    );

    const drawBackgroundNaive = (context, row, y) => {
      context.fillStyle = backgrounds[0];
      context.fillRect(0, y, width, cellHeight);
      for (let col = 0; col < cols; col += 1) {
        const cell = cells[row][col];
        if (cell.background !== backgrounds[0]) {
          context.fillStyle = cell.background;
          context.fillRect(col * cellWidth, y, cellWidth, cellHeight);
        }
      }
    };

    const drawForegroundNaive = (context, row, y) => {
      for (let col = 0; col < cols; col += 1) {
        const cell = cells[row][col];
        if (!cell.text) continue;
        context.fillStyle = cell.color;
        context.font = cell.font;
        context.fillText(cell.text, col * cellWidth, y + 28);
      }
    };

    const drawBackgroundRuns = (context, row, y, state) => {
      if (state.fill !== backgrounds[0]) {
        context.fillStyle = backgrounds[0];
        state.fill = backgrounds[0];
      }
      context.fillRect(0, y, width, cellHeight);
      let col = 0;
      while (col < cols) {
        const background = cells[row][col].background;
        if (background === backgrounds[0]) {
          col += 1;
          continue;
        }
        let end = col + 1;
        while (end < cols && cells[row][end].background === background) end += 1;
        if (state.fill !== background) {
          context.fillStyle = background;
          state.fill = background;
        }
        context.fillRect(col * cellWidth, y, (end - col) * cellWidth, cellHeight);
        col = end;
      }
    };

    const drawForegroundRuns = (context, row, y, state) => {
      let col = 0;
      while (col < cols) {
        const cell = cells[row][col];
        if (!cell.text) {
          col += 1;
          continue;
        }
        let text = cell.text;
        let end = col + 1;
        while (
          end < cols &&
          cells[row][end].color === cell.color &&
          cells[row][end].font === cell.font
        ) {
          text += cells[row][end].text || ' ';
          end += 1;
        }
        if (state.fill !== cell.color) {
          context.fillStyle = cell.color;
          state.fill = cell.color;
        }
        if (state.font !== cell.font) {
          context.font = cell.font;
          state.font = cell.font;
        }
        context.fillText(text, col * cellWidth, y + 28);
        col = end;
      }
    };

    const drawNaive = () => {
      for (let row = 0; row < rows; row += 1) {
        drawBackgroundNaive(naive.context, row, row * cellHeight);
      }
      for (let row = 0; row < rows; row += 1) {
        drawForegroundNaive(naive.context, row, row * cellHeight);
      }
    };

    const drawBatched = () => {
      const state = { fill: '', font: '' };
      for (let row = 0; row < rows; row += 1) {
        drawBackgroundRuns(batched.context, row, row * cellHeight, state);
      }
      for (let row = 0; row < rows; row += 1) {
        drawForegroundRuns(batched.context, row, row * cellHeight, state);
      }
    };

    const drawOneBatchedRow = () => {
      const state = { fill: '', font: '' };
      drawBackgroundRuns(batched.context, 20, 20 * cellHeight, state);
      drawForegroundRuns(batched.context, 20, 20 * cellHeight, state);
    };

    const drawNaiveForeground = () => {
      for (let row = 0; row < rows; row += 1) {
        drawForegroundNaive(naive.context, row, row * cellHeight);
      }
    };

    const drawBatchedForeground = () => {
      const state = { fill: '', font: '' };
      for (let row = 0; row < rows; row += 1) {
        drawForegroundRuns(batched.context, row, row * cellHeight, state);
      }
    };

    const isolatedGlyphs = 3912;
    const drawIsolatedCells = () => {
      naive.context.fillStyle = colors[0];
      naive.context.font = fonts[0];
      for (let index = 0; index < isolatedGlyphs; index += 1) {
        const row = Math.floor(index / cols);
        const col = index % cols;
        naive.context.fillText('x', col * cellWidth, row * cellHeight + 28);
      }
    };

    const drawIsolatedRuns = () => {
      batched.context.fillStyle = colors[0];
      batched.context.font = fonts[0];
      let index = 0;
      while (index < isolatedGlyphs) {
        const col = index % cols;
        const count = Math.min(20, cols - col, isolatedGlyphs - index);
        const row = Math.floor(index / cols);
        batched.context.fillText('x'.repeat(count), col * cellWidth, row * cellHeight + 28);
        index += count;
      }
    };

    drawBatched();
    self.context.drawImage(batched.canvas, 0, 0);
    blit.context.drawImage(batched.canvas, 0, 0);
    pingA.context.drawImage(batched.canvas, 0, 0);
    scratch.context.globalCompositeOperation = 'copy';

    const selfBlit = () => {
      self.context.drawImage(
        self.canvas,
        0,
        cellHeight,
        width,
        height - cellHeight,
        0,
        0,
        width,
        height - cellHeight
      );
      self.context.fillStyle = backgrounds[1];
      self.context.fillRect(0, height - cellHeight, width, cellHeight);
    };

    const scratchBlit = () => {
      scratch.context.drawImage(
        blit.canvas,
        0,
        cellHeight,
        width,
        height - cellHeight,
        0,
        0,
        width,
        height - cellHeight
      );
      blit.context.globalCompositeOperation = 'copy';
      blit.context.drawImage(
        scratch.canvas,
        0,
        0,
        width,
        height - cellHeight,
        0,
        0,
        width,
        height - cellHeight
      );
      blit.context.globalCompositeOperation = 'source-over';
      blit.context.fillStyle = backgrounds[1];
      blit.context.fillRect(0, height - cellHeight, width, cellHeight);
    };

    let pingSource = pingA;
    let pingTarget = pingB;
    const pingPongBlit = () => {
      pingTarget.context.globalCompositeOperation = 'copy';
      pingTarget.context.drawImage(
        pingSource.canvas,
        0,
        cellHeight,
        width,
        height - cellHeight,
        0,
        0,
        width,
        height - cellHeight
      );
      pingTarget.context.globalCompositeOperation = 'source-over';
      pingTarget.context.fillStyle = backgrounds[1];
      pingTarget.context.fillRect(0, height - cellHeight, width, cellHeight);
      pingSource.canvas.style.opacity = '0';
      pingTarget.canvas.style.opacity = '1';
      [pingSource, pingTarget] = [pingTarget, pingSource];
    };

    const stats = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      };
    };

    const measure = (run, flushContext, batchSize) => {
      for (let index = 0; index < warmups; index += 1) {
        run();
      }
      flushContext.getImageData(0, 0, 1, 1);
      const values = [];
      for (let index = 0; index < samples; index += 1) {
        const started = performance.now();
        for (let batch = 0; batch < batchSize; batch += 1) run();
        flushContext.getImageData(0, 0, 1, 1);
        values.push((performance.now() - started) / batchSize);
      }
      return stats(values);
    };

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const measurePingPong = async () => {
      for (const [canvas, opacity] of [
        [pingA.canvas, '1'],
        [pingB.canvas, '0'],
      ]) {
        canvas.style.width = `${width / devicePixelRatio}px`;
        canvas.style.height = `${height / devicePixelRatio}px`;
        canvas.style.position = 'absolute';
        canvas.style.opacity = opacity;
        document.body.appendChild(canvas);
      }
      for (let index = 0; index < 10; index += 1) {
        await nextFrame();
        pingPongBlit();
      }
      const values = [];
      for (let index = 0; index < 60; index += 1) {
        await nextFrame();
        const started = performance.now();
        pingPongBlit();
        values.push(performance.now() - started);
      }
      await nextFrame();
      pingA.canvas.remove();
      pingB.canvas.remove();
      return stats(values);
    };

    const selfBlitResult = measure(selfBlit, self.context, 10);
    const scratchBlitResult = measure(scratchBlit, blit.context, 10);
    const pingPongBlitResult = await measurePingPong();

    return {
      dpr: devicePixelRatio,
      cols,
      rows,
      visibleCells: cells.flat().filter((cell) => cell.text).length,
      naive: measure(drawNaive, naive.context, 10),
      batched: measure(drawBatched, batched.context, 10),
      naiveForeground: measure(drawNaiveForeground, naive.context, 10),
      batchedForeground: measure(drawBatchedForeground, batched.context, 10),
      isolatedCells: measure(drawIsolatedCells, naive.context, 50),
      isolatedRuns: measure(drawIsolatedRuns, batched.context, 50),
      oneRow: measure(drawOneBatchedRow, batched.context, 100),
      selfBlit: selfBlitResult,
      scratchBlit: scratchBlitResult,
      pingPongBlit: pingPongBlitResult,
    };
  });

  const format = (measurement) =>
    `mean=${measurement.mean.toFixed(3)}ms  p95=${measurement.p95.toFixed(3)}ms`;
  console.log(
    `canvas bench — Chromium ${browser.version()}, DPR ${result.dpr}, ${result.cols}x${result.rows}`
  );
  console.log(`visible glyph cells: ${result.visibleCells}`);
  console.log(`per-cell full screen  ${format(result.naive)}`);
  console.log(`run-batched screen   ${format(result.batched)}`);
  console.log(`speedup              ${(result.naive.mean / result.batched.mean).toFixed(2)}x`);
  console.log(`per-cell foreground  ${format(result.naiveForeground)}`);
  console.log(`batched foreground   ${format(result.batchedForeground)}`);
  console.log(
    `foreground speedup   ${(result.naiveForeground.mean / result.batchedForeground.mean).toFixed(2)}x`
  );
  console.log(`3912 single glyphs   ${format(result.isolatedCells)}`);
  console.log(`20-cell glyph runs   ${format(result.isolatedRuns)}`);
  console.log(
    `isolated speedup     ${(result.isolatedCells.mean / result.isolatedRuns.mean).toFixed(2)}x`
  );
  console.log(`one run-batched row  ${format(result.oneRow)}`);
  console.log(`self blit (raster)   ${format(result.selfBlit)}`);
  console.log(`two-hop scratch      ${format(result.scratchBlit)}`);
  console.log(`ping-pong blit       ${format(result.pingPongBlit)}`);
} finally {
  await browser.close();
}
