// termenal-web demo — renders our own shaping/bidi pipeline output.
//
// Nothing here relies on the browser's text engine: we shape with HarfBuzz-WASM
// via @termenal-web/terminal, reorder per UAX #9, then draw each glyph's real
// vector outline (font.glyphToPath) onto a 2D canvas. This is the honest proof
// that Arabic contextual joining works in the browser.

import {
  loadFont,
  shapeLogicalRow,
  visualGlyphStream,
  analyzeRow,
  type LoadedFont,
  type ShapedGlyph,
} from '@termenal-web/terminal';
import { shapeRun } from '@termenal-web/shaping';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing #${id}`);
  }
  return el as T;
};

const fontInput = $<HTMLInputElement>('font');
const fontStatus = $<HTMLSpanElement>('fontStatus');
const input = $<HTMLTextAreaElement>('input');
const sizeInput = $<HTMLInputElement>('size');
const sizeVal = $<HTMLSpanElement>('sizeVal');
const oursCanvas = $<HTMLCanvasElement>('ours');
const naiveCanvas = $<HTMLCanvasElement>('naive');
const details = $<HTMLPreElement>('details');

let font: LoadedFont | null = null;
let fontSize = Number(sizeInput.value);

const PAD = 16;
const LINE_GAP = 1.5; // multiple of font size

/** Best-effort SVG path for a glyph; empty string for blanks/.notdef. */
function glyphPath(loaded: LoadedFont, glyphId: number): string {
  if (glyphId === 0) {
    return '';
  }
  try {
    return loaded.font.glyphToPath(glyphId) || '';
  } catch {
    return '';
  }
}

/**
 * Draw a positioned glyph stream left-to-right from `startX` on `baselineY`.
 * Glyph outlines are in font design units (y-up); we scale by size/unitsPerEm
 * and flip the y axis for canvas (y-down). Returns the advance width used.
 */
function drawGlyphs(
  ctx: CanvasRenderingContext2D,
  loaded: LoadedFont,
  glyphs: readonly ShapedGlyph[],
  startX: number,
  baselineY: number,
  color: string,
): number {
  const scale = fontSize / loaded.unitsPerEm;
  ctx.fillStyle = color;
  let penX = startX;
  for (const g of glyphs) {
    const d = glyphPath(loaded, g.glyphId);
    if (d) {
      const path = new Path2D(d);
      ctx.save();
      ctx.translate(penX + g.xOffset * scale, baselineY - g.yOffset * scale);
      ctx.scale(scale, -scale);
      ctx.fill(path);
      ctx.restore();
    }
    penX += g.xAdvance * scale;
  }
  return penX - startX;
}

/** Isolated, unjoined glyphs in logical order — the "naive renderer" contrast. */
function isolatedGlyphs(loaded: LoadedFont, text: string): ShapedGlyph[] {
  const out: ShapedGlyph[] = [];
  for (const ch of text) {
    // Shaping a single code point yields its isolated form (no neighbours).
    for (const g of shapeRun(loaded, ch)) {
      out.push(g);
    }
  }
  return out;
}

function sizeCanvas(canvas: HTMLCanvasElement, lines: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.parentElement!.clientWidth - 24;
  const cssHeight = Math.max(1, lines) * fontSize * LINE_GAP + PAD * 2;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}

function render(): void {
  const lines = input.value.split('\n');

  if (!font) {
    for (const c of [oursCanvas, naiveCanvas]) {
      const ctx = sizeCanvas(c, 1);
      ctx.fillStyle = '#8b949e';
      ctx.font = '14px sans-serif';
      ctx.direction = 'rtl';
      ctx.fillText('اختر خطًّا أولًا لعرض التشكيل', PAD, PAD + 20);
    }
    details.textContent = '—';
    return;
  }

  const oursCtx = sizeCanvas(oursCanvas, lines.length);
  const naiveCtx = sizeCanvas(naiveCanvas, lines.length);
  const step = fontSize * LINE_GAP;

  const report: string[] = [];
  lines.forEach((line, i) => {
    const baseline = PAD + fontSize + i * step;

    // --- our pipeline: bidi runs + HarfBuzz joining, in visual order ---
    const row = shapeLogicalRow(font!, line);
    const stream = visualGlyphStream(row);
    drawGlyphs(oursCtx, font!, stream, PAD, baseline, '#e6edf3');

    // --- naive: isolated glyphs, logical order, no bidi/joining ---
    drawGlyphs(naiveCtx, font!, isolatedGlyphs(font!, line), PAD, baseline, '#8b949e');

    // --- diagnostics ---
    const analysis = analyzeRow(line);
    const runs = analysis.runs
      .map((r) => `${r.direction}:"${r.text}"`)
      .join('  ');
    report.push(
      `line ${i}: base=${analysis.baseDirection}  glyphs=${stream.length}  runs=[${runs || '∅'}]`,
    );
  });

  details.textContent = report.join('\n');
}

async function loadFontFromFile(file: File): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    font = loadFont(bytes);
    fontStatus.textContent = `تم تحميل "${file.name}" (${bytes.length.toLocaleString()} بايت، unitsPerEm=${font.unitsPerEm})`;
    fontStatus.className = 'status ok';
    render();
  } catch (err) {
    font = null;
    fontStatus.textContent = `تعذّر قراءة الخط: ${(err as Error).message}`;
    fontStatus.className = 'status warn';
  }
}

fontInput.addEventListener('change', () => {
  const file = fontInput.files?.[0];
  if (file) {
    void loadFontFromFile(file);
  }
});

input.addEventListener('input', render);

sizeInput.addEventListener('input', () => {
  fontSize = Number(sizeInput.value);
  sizeVal.textContent = String(fontSize);
  render();
});

for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.samples button'))) {
  btn.addEventListener('click', () => {
    input.value = btn.dataset.sample ?? '';
    render();
  });
}

window.addEventListener('resize', render);

render();
