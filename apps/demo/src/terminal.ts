// termenal-web — real browser terminal, wired to a real OS shell.
//
// Data path:
//   PowerShell (ConPTY) --ws--> here --> @xterm/headless (VT state machine)
//     --> OUR pipeline (@termenal-web/terminal: BiDi + HarfBuzz joining)
//     --> Canvas2D glyph outlines.
//
// @xterm/headless owns ONLY the VT parser + screen buffer (no rendering); it is
// a temporary core that P5 replaces with our Rust->WASM VT engine. Everything
// visible — Arabic contextual joining, bidi run order, colour — is ours. The
// buffer holds one logical code point per cell; we read each row left-to-right,
// rebuild the logical string, and shape+reorder it so Arabic joins correctly.

import { Terminal } from '@xterm/headless';
import {
  loadFont,
  shapeLogicalRow,
  reorderRunsVisually,
  type LoadedFont,
  type RunSpan,
  type ShapedRun,
} from '@termenal-web/terminal';
import { shapeRun, totalAdvance } from '@termenal-web/shaping';

// The buffer interfaces aren't named exports of @xterm/headless (they live
// unexported inside its `declare module`), so derive them from the public API.
type XBuffer = Terminal['buffer']['active'];
type BufLine = NonNullable<ReturnType<XBuffer['getLine']>>;
type BufCell = NonNullable<ReturnType<BufLine['getCell']>>;

// ---------------------------------------------------------------- DOM handles
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};
const monoInput = $<HTMLInputElement>('fontMono');
const arabicInput = $<HTMLInputElement>('fontArabic');
const connectBtn = $<HTMLButtonElement>('connect');
const disconnectBtn = $<HTMLButtonElement>('disconnect');
const statusEl = $<HTMLSpanElement>('status');
const sizeInput = $<HTMLInputElement>('size');
const sizeVal = $<HTMLSpanElement>('sizeVal');
const termWrap = $<HTMLDivElement>('termWrap');
const canvas = $<HTMLCanvasElement>('screen');
const ctx = canvas.getContext('2d')!;

// -------------------------------------------------------------------- palette
// VS Code's terminal ANSI palette — legible on a dark background.
const BASE16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];
const DEFAULT_FG = '#e6edf3';
const DEFAULT_BG = '#0a0e14';

const toHex = (r: number, g: number, b: number): string =>
  `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

/** Resolve an xterm 256-colour palette index to a CSS colour. */
function xterm256(i: number): string {
  if (i < 16) return BASE16[i] ?? DEFAULT_FG;
  if (i < 232) {
    const n = i - 16;
    const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return toHex(level(Math.floor(n / 36)), level(Math.floor((n % 36) / 6)), level(n % 6));
  }
  const c = 8 + (i - 232) * 10;
  return toHex(c, c, c);
}

/** Foreground colour of a cell, honouring RGB / palette / default + bold-bright. */
function fgColor(cell: BufCell): string {
  if (cell.isFgDefault()) return DEFAULT_FG;
  if (cell.isFgRGB()) {
    const v = cell.getFgColor();
    return toHex((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  let idx = cell.getFgColor();
  if (cell.isBold() && idx < 8) idx += 8; // bold brightens the base 8 colours
  return xterm256(idx);
}

/** Background colour of a cell (RGB / palette / default). */
function bgColor(cell: BufCell): string {
  if (cell.isBgDefault()) return DEFAULT_BG;
  if (cell.isBgRGB()) {
    const v = cell.getBgColor();
    return toHex((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  return xterm256(cell.getBgColor());
}

// ---------------------------------------------------------------------- fonts
let monoFont: LoadedFont | null = null;
let arabicFont: LoadedFont | null = null;
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Pick the font for a run: Arabic font for RTL/Arabic runs when available. */
function resolveFont(run: RunSpan): LoadedFont {
  if (arabicFont && (run.direction === 'rtl' || ARABIC_RE.test(run.text))) return arabicFont;
  return monoFont!;
}

function glyphPath(font: LoadedFont, glyphId: number): string {
  if (glyphId === 0) return '';
  try {
    return font.font.glyphToPath(glyphId) || '';
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------- metrics
let fontSize = Number(sizeInput.value);
let cellW = 10;
let lineH = 20;
let baseOff = 16;
let cols = 80;
let rows = 24;
let dpr = 1;

function computeMetrics(): void {
  if (!monoFont) return;
  const scale = fontSize / monoFont.unitsPerEm;
  const adv = totalAdvance(shapeRun(monoFont, 'M'));
  const advUnits = adv > 0 ? adv : monoFont.unitsPerEm * 0.6;
  cellW = Math.max(1, Math.round(advUnits * scale));
  lineH = Math.round(fontSize * 1.4);
  baseOff = Math.round(fontSize);
}

// ------------------------------------------------------------------ terminal
const term = new Terminal({
  cols,
  rows,
  allowProposedApi: true,
  scrollback: 1000,
  convertEol: false,
});

let dirty = true;
const markDirty = (): void => {
  dirty = true;
};

function applyGrid(): void {
  if (!monoFont) return;
  computeMetrics();
  const availW = Math.max(cellW * 20, termWrap.clientWidth - 16);
  cols = Math.max(20, Math.floor(availW / cellW));
  const topY = termWrap.getBoundingClientRect().top;
  const availH = Math.max(lineH * 6, window.innerHeight - topY - 90);
  rows = Math.min(60, Math.max(6, Math.floor(availH / lineH)));

  const cssW = cols * cellW;
  const cssH = rows * lineH;
  dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  term.resize(cols, rows);
  if (connected) sendResize();
  markDirty();
}

// ------------------------------------------------------------------ rendering
interface RowModel {
  text: string;
  /** fg CSS colour per UTF-16 offset of `text`. */
  fgAt: string[];
  /** Per-cell background rectangles that differ from the default. */
  bg: { x: number; w: number; css: string }[];
  /** Buffer cell column for each UTF-16 offset of `text`. */
  colOfOffset: number[];
  /** Number of grid cells the (trimmed) content occupies from column 0. */
  usedCols: number;
}

function buildRow(line: BufLine): RowModel {
  let text = '';
  const fgAt: string[] = [];
  const colOfOffset: number[] = [];
  const bg: { x: number; w: number; css: string }[] = [];
  let contentRight = 0; // one past the last non-blank cell
  const scratch = term.buffer.active.getNullCell?.();
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell) continue;
    const w = cell.getWidth();
    if (w === 0) continue; // second half of a wide glyph
    let chars = cell.getChars();
    if (chars === '') chars = ' ';

    const inverse = cell.isInverse();
    const fg = inverse ? bgColor(cell) : fgColor(cell);
    const bgc = inverse ? fgColor(cell) : bgColor(cell);
    for (let i = 0; i < chars.length; i++) {
      fgAt.push(fg);
      colOfOffset.push(x);
    }
    text += chars;
    if (bgc !== DEFAULT_BG) bg.push({ x, w, css: bgc });
    if (chars !== ' ') contentRight = x + w;
  }
  // Trim trailing blanks for cheaper shaping (bg rects already captured above).
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end--;
  return {
    text: text.slice(0, end),
    fgAt: fgAt.slice(0, end),
    bg,
    colOfOffset: colOfOffset.slice(0, end),
    usedCols: contentRight,
  };
}

// A laid-out row: shaped runs placed on the cell grid, with a logical-cell ->
// visual-cell permutation so Arabic lines can be right-aligned (RTL base) and so
// the cursor and selection map onto the mirrored cells correctly.
interface RowLayout {
  model: RowModel;
  baseDir: 'ltr' | 'rtl';
  usedCols: number;
  /** True when the row is drawn on the strict physical grid (app-painted UI). */
  physical: boolean;
  /** Draw order: each run with the grid column its first glyph starts at. */
  bands: { run: ShapedRun; startVisualCol: number }[];
  /** Visual grid column for a given logical cell column. */
  colToVisual: number[];
  /** Logical cell column for a given visual grid column. */
  visualToCol: number[];
}

// Full-screen / TUI applications (copilot CLI, vim, less, git log …) paint boxes,
// status bars and coloured backgrounds and position every glyph by absolute
// column. Per-line paragraph BiDi (right-aligning a row, or mirroring its runs
// because it happens to contain more Arabic than Latin) shears that layout: some
// rows flip while their neighbours don't, so borders and bars stop lining up.
// We detect such rows and pin them to the physical grid — Arabic is still shaped
// and mirrored *within* each run, but the columns the app chose are preserved.
function isStructuredRow(model: RowModel): boolean {
  if (term.buffer.active.type === 'alternate') return true; // full-screen app
  if (model.bg.length > 0) return true; // background bars / boxes / highlights
  for (const ch of model.text) {
    const cp = ch.codePointAt(0) ?? 0;
    // Box drawing (U+2500–257F) + block elements (U+2580–259F) = drawn frames.
    if (cp >= 0x2500 && cp <= 0x259f) return true;
  }
  return false;
}

function computeRowLayout(model: RowModel): RowLayout {
  const shaped = shapeLogicalRow(resolveFont, model.text);
  const baseDir = shaped.baseDirection;
  const usedCols = Math.min(model.usedCols, cols);
  const physical = isStructuredRow(model);

  const colToVisual: number[] = new Array(cols);
  const visualToCol: number[] = new Array(cols);
  for (let c = 0; c < cols; c++) {
    colToVisual[c] = c;
    visualToCol[c] = c;
  }

  const bands: RowLayout['bands'] = [];
  const runCells = (run: ShapedRun): number[] => {
    const cells: number[] = [];
    let prev = -1;
    for (let o = run.start; o < run.end; o++) {
      const c = model.colOfOffset[o]!;
      if (c !== prev) {
        cells.push(c);
        prev = c;
      }
    }
    return cells;
  };

  if (physical) {
    // Physical grid: every run stays at the columns the app placed it in; only
    // the glyphs inside an RTL run are mirrored so the Arabic word reads R→L.
    for (const run of shaped.runs) {
      const cells = runCells(run);
      const n = cells.length;
      const start = cells[0] ?? 0;
      for (let i = 0; i < n; i++) {
        const logicalCol = cells[i]!;
        const posInBand = run.direction === 'rtl' ? n - 1 - i : i;
        colToVisual[logicalCol] = start + posInBand;
      }
      bands.push({ run, startVisualCol: start });
    }
  } else {
    // Plain shell output: full paragraph BiDi + right-align RTL paragraphs.
    const reordered = reorderRunsVisually(shaped.runs);
    const shift = baseDir === 'rtl' ? Math.max(0, cols - usedCols) : 0;
    let v = 0;
    for (const run of reordered) {
      const cells = runCells(run);
      const n = cells.length;
      for (let i = 0; i < n; i++) {
        const logicalCol = cells[i]!;
        const posInBand = run.direction === 'rtl' ? n - 1 - i : i;
        colToVisual[logicalCol] = shift + v + posInBand;
      }
      bands.push({ run, startVisualCol: shift + v });
      v += n;
    }
    // Trailing blank logical cells fill the grid columns the content left empty.
    if (baseDir === 'rtl') {
      for (let c = usedCols; c < cols; c++) colToVisual[c] = c - usedCols;
    }
  }

  for (let c = 0; c < cols; c++) {
    const vc = colToVisual[c];
    if (vc !== undefined && vc >= 0 && vc < cols) visualToCol[vc] = c;
  }
  return { model, baseDir, usedCols, physical, bands, colToVisual, visualToCol };
}

function drawRow(y: number, layout: RowLayout): void {
  const top = y * lineH;
  const model = layout.model;
  for (const rect of model.bg) {
    const vc = layout.colToVisual[rect.x] ?? rect.x;
    ctx.fillStyle = rect.css;
    ctx.fillRect(vc * cellW, top, cellW * rect.w, lineH);
  }
  if (model.text.length === 0) return;

  const baseline = top + baseOff;
  for (const band of layout.bands) {
    const run = band.run;
    const font = resolveFont(run);
    const sc = fontSize / font.unitsPerEm;
    let penX = band.startVisualCol * cellW;
    for (const g of run.glyphs) {
      const color = model.fgAt[run.start + g.cluster] ?? DEFAULT_FG;
      const d = glyphPath(font, g.glyphId);
      if (d) {
        ctx.save();
        ctx.fillStyle = color;
        ctx.translate(penX + g.xOffset * sc, baseline - g.yOffset * sc);
        ctx.scale(sc, -sc);
        ctx.fill(new Path2D(d));
        ctx.restore();
      }
      penX += g.xAdvance * sc;
    }
  }
}

let cursorOn = true;
let focused = false;

// --------------------------------------------------------------- scroll state
// Absolute buffer line shown at the top of the viewport. When `stickBottom` is
// true we follow new output; the wheel detaches to browse the scrollback.
let scrollTop = 0;
let stickBottom = true;
let viewTop = 0; // resolved top line of the current frame (for hit-testing)

// ------------------------------------------------------------ selection state
interface CellPos {
  line: number; // absolute buffer line index
  col: number; // logical cell column
}
let selAnchor: CellPos | null = null;
let selFocus: CellPos | null = null;
let selecting = false;

/** Ordered [start, end] of the current selection, or null. */
function selectionRange(): [CellPos, CellPos] | null {
  if (!selAnchor || !selFocus) return null;
  const a = selAnchor;
  const b = selFocus;
  // A zero-width selection (a bare click) is not a selection: Ctrl+C must still
  // reach the shell as SIGINT rather than being swallowed as a copy.
  if (a.line === b.line && a.col === b.col) return null;
  if (a.line < b.line || (a.line === b.line && a.col <= b.col)) return [a, b];
  return [b, a];
}

// Per-frame layout cache so cursor drawing, selection highlight and mouse
// hit-testing all agree with what was actually painted.
const frameLayouts: (RowLayout | null)[] = [];

function render(): void {
  if (!monoFont) return;
  ctx.fillStyle = DEFAULT_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const buf = term.buffer.active;
  const baseY = buf.baseY;
  if (stickBottom) scrollTop = baseY;
  scrollTop = Math.max(0, Math.min(scrollTop, baseY));
  viewTop = scrollTop;

  frameLayouts.length = 0;
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(viewTop + y);
    const layout = line ? computeRowLayout(buildRow(line)) : null;
    frameLayouts[y] = layout;
    if (layout) drawRow(y, layout);
  }

  drawSelection();

  // Block cursor at its (possibly mirrored) grid cell — only while pinned to the
  // live bottom, since the cursor lives on the active viewport.
  const curScreenY = baseY + buf.cursorY - viewTop;
  if (cursorOn && curScreenY >= 0 && curScreenY < rows) {
    const layout = frameLayouts[curScreenY];
    const vcol = layout?.colToVisual[buf.cursorX] ?? buf.cursorX;
    ctx.fillStyle = focused ? 'rgba(88,166,255,0.75)' : 'rgba(88,166,255,0.35)';
    ctx.fillRect(vcol * cellW, curScreenY * lineH, cellW, lineH);
  }

  const glyphs = countGlyphs();
  (window as unknown as Record<string, unknown>).__termStats = {
    cols,
    rows,
    cursorX: buf.cursorX,
    cursorY: buf.cursorY,
    connected,
    glyphs,
    scrolledBack: baseY - viewTop,
    hasSelection: selectionRange() !== null,
  };
}

/** Translucent highlight over the selected cells (visual positions). */
function drawSelection(): void {
  const range = selectionRange();
  if (!range) return;
  const [start, end] = range;
  ctx.fillStyle = 'rgba(88,166,255,0.30)';
  for (let y = 0; y < rows; y++) {
    const absLine = viewTop + y;
    if (absLine < start.line || absLine > end.line) continue;
    const layout = frameLayouts[y];
    const c0 = absLine === start.line ? start.col : 0;
    const c1 = absLine === end.line ? end.col : cols;
    for (let c = c0; c < c1 && c < cols; c++) {
      const vc = layout?.colToVisual[c] ?? c;
      ctx.fillRect(vc * cellW, y * lineH, cellW, lineH);
    }
  }
}

// Diagnostic helper (used by the headless verifier): count drawn glyphs.
function countGlyphs(): number {
  let n = 0;
  for (let y = 0; y < rows; y++) {
    const layout = frameLayouts[y];
    if (!layout) continue;
    for (const band of layout.bands) n += band.run.glyphs.length;
  }
  return n;
}

/** Plain-text dump of the visible buffer — for assertions in verification. */
(window as unknown as Record<string, unknown>).__dumpBuffer = (): string => {
  const buf = term.buffer.active;
  const top = buf.baseY;
  const out: string[] = [];
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(top + y);
    out.push(line ? line.translateToString(true) : '');
  }
  return out.join('\n');
};

// ------------------------------------------------------------- websocket link
const WS_URL = `ws://${location.hostname || '127.0.0.1'}:5179`;
let ws: WebSocket | null = null;
let connected = false;

function setStatus(text: string, cls: 'ok' | 'warn' | 'err'): void {
  statusEl.className = `status ${cls}`;
  statusEl.innerHTML = `<span class="dot ${cls}"></span>${text}`;
}

interface ServerMsg {
  type: 'ready' | 'data' | 'exit';
  data?: string;
  shell?: string;
  pid?: number;
  code?: number;
}

function connect(): void {
  if (!monoFont) {
    setStatus('اختر خطًّا أحاديًّا أولًا', 'warn');
    return;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  setStatus('يتصل بالجسر المحلي…', 'warn');
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    setStatus('تعذّر إنشاء الاتصال', 'err');
    return;
  }

  ws.onopen = (): void => {
    connected = true;
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    sendResize();
    termWrap.focus();
  };
  ws.onmessage = (ev): void => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(ev.data as string) as ServerMsg;
    } catch {
      return;
    }
    if (msg.type === 'data' && typeof msg.data === 'string') {
      term.write(msg.data, markDirty);
    } else if (msg.type === 'ready') {
      setStatus(`متّصل — ${msg.shell} (pid ${msg.pid})`, 'ok');
    } else if (msg.type === 'exit') {
      setStatus(`انتهت الصدفة (رمز ${msg.code})`, 'warn');
    }
  };
  ws.onerror = (): void => {
    setStatus('تعذّر الاتصال — هل شغّلت الجسر؟ npm run server -w @termenal-web/terminal-server', 'err');
  };
  ws.onclose = (): void => {
    connected = false;
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
    if (statusEl.className.indexOf('err') === -1) setStatus('انقطع الاتصال', 'warn');
  };
}

function disconnect(): void {
  if (ws) {
    ws.close();
    ws = null;
  }
}

function sendInput(data: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data }));
  }
}

function sendResize(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }
}

// ------------------------------------------------------------- keyboard input
function keyToBytes(e: KeyboardEvent): string | null {
  const k = e.key;
  switch (k) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\x1b';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'Delete':
      return '\x1b[3~';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    default:
      break;
  }
  if (e.ctrlKey && k.length === 1) {
    const c = k.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96); // Ctrl+A..Z
    if (k === ' ') return '\x00';
  }
  if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return k;
  return null;
}

termWrap.addEventListener('keydown', (e) => {
  // Ctrl+C is the command line's most important key: with an active selection it
  // copies (and clears it); otherwise it falls through to keyToBytes and reaches
  // the shell as SIGINT (\x03). Ctrl+V pastes. We deliberately avoid Ctrl+Shift+C
  // / Ctrl+Shift+V because those are reserved by the browser (dev tools).
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C') && selectionRange()) {
    e.preventDefault();
    const p = selectionClientPos();
    void copySelectionNotify(p.x, p.y);
    return;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    lastKbPasteAt = Date.now();
    const p = cursorClientPos();
    void pasteNotify(p.x, p.y);
    return;
  }
  if (!connected) return;
  const bytes = keyToBytes(e);
  if (bytes !== null) {
    e.preventDefault();
    clearSelection();
    snapToBottom();
    sendInput(bytes);
  }
});
termWrap.addEventListener('paste', (e) => {
  if (!connected) return;
  if (Date.now() - lastKbPasteAt < 300) return; // already handled by the Ctrl+V keydown
  const text = e.clipboardData?.getData('text');
  if (text) {
    e.preventDefault();
    snapToBottom();
    sendInput(text);
    const p = cursorClientPos();
    showToast('تم اللصق ✓', p.x, p.y, 'ok');
  }
});
termWrap.addEventListener('focus', () => {
  focused = true;
  cursorOn = true;
  markDirty();
});
termWrap.addEventListener('blur', () => {
  focused = false;
  markDirty();
});

// ----------------------------------------------------------- scroll & selection
function snapToBottom(): void {
  stickBottom = true;
  markDirty();
}

function scrollByLines(delta: number): void {
  const baseY = term.buffer.active.baseY;
  const cur = stickBottom ? baseY : scrollTop;
  const next = Math.max(0, Math.min(cur + delta, baseY));
  scrollTop = next;
  stickBottom = next >= baseY;
  markDirty();
}

termWrap.addEventListener(
  'wheel',
  (e) => {
    const step = e.deltaMode === 1 ? 1 : 3; // lines vs pixels
    const lines = Math.sign(e.deltaY) * step;
    if (lines !== 0) {
      e.preventDefault();
      scrollByLines(lines);
    }
  },
  { passive: false },
);

function clearSelection(): void {
  if (selAnchor || selFocus) {
    selAnchor = null;
    selFocus = null;
    markDirty();
  }
}

/** Map a canvas pixel to an absolute buffer cell (accounts for RTL mirroring). */
function hitTest(px: number, py: number): CellPos {
  const y = Math.max(0, Math.min(Math.floor(py / lineH), rows - 1));
  const layout = frameLayouts[y];
  const vcol = Math.max(0, Math.min(Math.floor(px / cellW), cols));
  const col = layout?.visualToCol[vcol] ?? vcol;
  return { line: viewTop + y, col };
}

/** Extract the selected text in LOGICAL (buffer) order — correct for pasting. */
function selectionText(): string {
  const range = selectionRange();
  if (!range) return '';
  const [start, end] = range;
  const buf = term.buffer.active;
  const scratch = buf.getNullCell?.();
  const out: string[] = [];
  for (let line = start.line; line <= end.line; line++) {
    const bl = buf.getLine(line);
    if (!bl) {
      out.push('');
      continue;
    }
    const c0 = line === start.line ? start.col : 0;
    const c1 = line === end.line ? end.col : cols;
    let s = '';
    for (let x = c0; x < c1; x++) {
      const cell = bl.getCell(x, scratch);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars();
      s += chars === '' ? ' ' : chars;
    }
    out.push(s.replace(/\s+$/, ''));
  }
  return out.join('\n');
}

// Last known pointer position (viewport coords), so keyboard-triggered toasts
// still have a sensible anchor.
let lastPointer = { x: 0, y: 0 };
// Timestamp of the last Ctrl+V so the native paste event can avoid a double.
let lastKbPasteAt = 0;

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Silent copy (used by copy-on-select and double-click). */
async function copySelection(): Promise<void> {
  const text = selectionText();
  if (text) await writeClipboard(text);
}

/** An evaporating toast that rises from (clientX, clientY) then fades out. */
function showToast(text: string, clientX: number, clientY: number, kind: 'ok' | 'err' | 'info' = 'ok'): void {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  el.style.left = `${clientX}px`;
  el.style.top = `${clientY}px`;
  document.body.appendChild(el);
  const anim = el.animate(
    [
      { opacity: 0, transform: 'translate(-50%, -40%) scale(0.92)' },
      { opacity: 1, transform: 'translate(-50%, -95%) scale(1)', offset: 0.18 },
      { opacity: 0.95, transform: 'translate(-50%, -150%) scale(1)', offset: 0.55 },
      { opacity: 0, transform: 'translate(-50%, -260%) scale(1.02)' },
    ],
    { duration: 1200, easing: 'ease-out' },
  );
  const done = (): void => el.remove();
  anim.onfinish = done;
  anim.oncancel = done;
}

/** Viewport position of a buffer cell (clamped onto the canvas). */
function cellClientPos(line: number, col: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const screenY = Math.max(0, Math.min(line - viewTop, rows - 1));
  const layout = frameLayouts[screenY];
  const vcol = layout?.colToVisual[col] ?? col;
  return {
    x: rect.left + (vcol + 0.5) * cellW,
    y: rect.top + (screenY + 0.5) * lineH,
  };
}

/** Viewport position of the terminal text cursor cell (for paste toasts). */
function cursorClientPos(): { x: number; y: number } {
  const buf = term.buffer.active;
  return cellClientPos(buf.baseY + buf.cursorY, buf.cursorX);
}

/** Viewport position of the selection start (for keyboard-copy toasts). */
function selectionClientPos(): { x: number; y: number } {
  const range = selectionRange();
  if (range) return cellClientPos(range[0].line, range[0].col);
  return lastPointer;
}

/** Copy the selection, clear it, and confirm with a toast at (x, y). */
async function copySelectionNotify(x: number, y: number): Promise<void> {
  const text = selectionText();
  if (!text) return;
  const ok = await writeClipboard(text);
  clearSelection();
  if (ok) showToast('تم النسخ ✓ أُضيف إلى الحافظة', x, y, 'ok');
  else showToast('تعذّر النسخ — امنح إذن الحافظة', x, y, 'err');
}

/** Paste the clipboard at the shell cursor and confirm with a toast at (x, y). */
async function pasteNotify(x: number, y: number): Promise<void> {
  if (!connected) {
    showToast('غير متّصل بالصدفة', x, y, 'err');
    return;
  }
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    showToast('تعذّر اللصق — امنح إذن الحافظة', x, y, 'err');
    return;
  }
  if (!text) return;
  snapToBottom();
  sendInput(text);
  showToast('تم اللصق ✓', x, y, 'ok');
}

canvas.addEventListener('mousedown', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (e.button !== 0) return;
  termWrap.focus();
  const p = hitTest(e.offsetX, e.offsetY);
  selAnchor = p;
  selFocus = p;
  selecting = true;
  markDirty();
});
window.addEventListener('mousemove', (e) => {
  if (!selecting) return;
  const r = canvas.getBoundingClientRect();
  lastPointer = { x: e.clientX, y: e.clientY };
  selFocus = hitTest(e.clientX - r.left, e.clientY - r.top);
  markDirty();
});
canvas.addEventListener('mousemove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
});
window.addEventListener('mouseup', () => {
  if (!selecting) return;
  selecting = false;
  void copySelection(); // copy-on-select, like a native terminal
});
// The canvas has no native context menu worth showing (right-click would offer
// "save image"), so repurpose it: right-click copies+clears an active selection,
// otherwise it pastes at the shell cursor. Both confirm with an evaporating toast.
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  lastPointer = { x: e.clientX, y: e.clientY };
  if (selectionRange()) {
    void copySelectionNotify(e.clientX, e.clientY);
  } else {
    void pasteNotify(e.clientX, e.clientY);
  }
});
// Double-click selects the word under the pointer.
canvas.addEventListener('dblclick', (e) => {
  const layout = frameLayouts[Math.max(0, Math.min(Math.floor(e.offsetY / lineH), rows - 1))];
  const p = hitTest(e.offsetX, e.offsetY);
  const bl = term.buffer.active.getLine(p.line);
  if (!bl || !layout) return;
  const scratch = term.buffer.active.getNullCell?.();
  const isWord = (x: number): boolean => {
    const cell = bl.getCell(x, scratch);
    const ch = cell?.getChars() ?? '';
    return ch !== '' && ch !== ' ';
  };
  if (!isWord(p.col)) return;
  let a = p.col;
  let b = p.col;
  while (a > 0 && isWord(a - 1)) a--;
  while (b < cols - 1 && isWord(b + 1)) b++;
  selAnchor = { line: p.line, col: a };
  selFocus = { line: p.line, col: b + 1 };
  void copySelection();
  markDirty();
});

// --------------------------------------------------------------- font loading
async function loadFontFile(file: File, which: 'mono' | 'arabic'): Promise<void> {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const font = loadFont(bytes);
    if (which === 'mono') {
      monoFont = font;
      connectBtn.disabled = false;
      if (!connected) setStatus('جاهز — اضغط «الاتصال بالصدفة»', 'ok');
      applyGrid();
    } else {
      arabicFont = font;
      markDirty();
    }
    (window as unknown as Record<string, unknown>).__fontsReady = monoFont !== null;
  } catch (err) {
    setStatus(`تعذّر قراءة الخط: ${(err as Error).message}`, 'err');
  }
}

monoInput.addEventListener('change', () => {
  const f = monoInput.files?.[0];
  if (f) void loadFontFile(f, 'mono');
});
arabicInput.addEventListener('change', () => {
  const f = arabicInput.files?.[0];
  if (f) void loadFontFile(f, 'arabic');
});

// Bundled, openly-licensed defaults (SIL OFL) so the terminal works the instant
// the page opens — no font picker needed. The pickers above stay as overrides.
const DEFAULT_MONO_URL = '/fonts/Cousine-Regular.ttf';
const DEFAULT_ARABIC_URL = '/fonts/Tajawal-Regular.ttf';

async function loadFontFromUrl(url: string): Promise<LoadedFont> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return loadFont(new Uint8Array(await res.arrayBuffer()));
}

async function autoInit(): Promise<void> {
  setStatus('يحمّل الخط الافتراضي…', 'warn');
  try {
    const [mono, arabic] = await Promise.all([
      loadFontFromUrl(DEFAULT_MONO_URL),
      loadFontFromUrl(DEFAULT_ARABIC_URL),
    ]);
    monoFont = mono;
    arabicFont = arabic;
    (window as unknown as Record<string, unknown>).__fontsReady = true;
    connectBtn.disabled = false;
    applyGrid();
    connect(); // auto-connect for an immediately-live terminal
  } catch (err) {
    setStatus(
      `تعذّر تحميل الخط الافتراضي (${(err as Error).message}) — اختر خطًّا يدويًّا`,
      'err',
    );
  }
}

// ------------------------------------------------------------------- controls
connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
sizeInput.addEventListener('input', () => {
  fontSize = Number(sizeInput.value);
  sizeVal.textContent = String(fontSize);
  applyGrid();
});
window.addEventListener('resize', () => {
  if (monoFont) applyGrid();
});

// --------------------------------------------------------------- render loop
function frame(): void {
  if (dirty) {
    dirty = false;
    render();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => {
  cursorOn = !cursorOn;
  if (focused) markDirty();
}, 530);

// Verification/debug hooks (used by the headless E2E verifier).
(window as unknown as Record<string, unknown>).__rowInfo = () =>
  frameLayouts.map((l, y) =>
    l
      ? {
          y,
          text: l.model.text,
          baseDir: l.baseDir,
          physical: l.physical,
          startVisualCol: l.bands[0]?.startVisualCol ?? 0,
          usedCols: l.usedCols,
        }
      : null,
  );
(window as unknown as Record<string, unknown>).__selectionText = () => selectionText();
(window as unknown as Record<string, unknown>).__scrollByLines = (n: number) => scrollByLines(n);

void autoInit();
