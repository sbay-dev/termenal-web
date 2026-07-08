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
}

function buildRow(line: BufLine): RowModel {
  let text = '';
  const fgAt: string[] = [];
  const bg: { x: number; w: number; css: string }[] = [];
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
    for (let i = 0; i < chars.length; i++) fgAt.push(fg);
    text += chars;
    if (bgc !== DEFAULT_BG) bg.push({ x, w, css: bgc });
  }
  // Trim trailing blanks for cheaper shaping (bg rects already captured above).
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0x20) end--;
  return { text: text.slice(0, end), fgAt, bg };
}

function drawRow(y: number, model: RowModel): void {
  const top = y * lineH;
  for (const rect of model.bg) {
    ctx.fillStyle = rect.css;
    ctx.fillRect(rect.x * cellW, top, cellW * rect.w, lineH);
  }
  if (model.text.length === 0) return;

  const baseline = top + baseOff;
  const row = shapeLogicalRow(resolveFont, model.text);
  let penX = 0;
  for (const run of reorderRunsVisually(row.runs)) {
    const font = resolveFont(run);
    const sc = fontSize / font.unitsPerEm;
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

function render(): void {
  if (!monoFont) return;
  ctx.fillStyle = DEFAULT_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const buf = term.buffer.active;
  const top = buf.baseY;
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(top + y);
    if (line) drawRow(y, buildRow(line));
  }

  // Block cursor at grid column/row (accurate for monospace content).
  if (cursorOn && buf.cursorY >= 0 && buf.cursorY < rows) {
    ctx.fillStyle = focused ? 'rgba(88,166,255,0.75)' : 'rgba(88,166,255,0.35)';
    ctx.fillRect(buf.cursorX * cellW, buf.cursorY * lineH, cellW, lineH);
  }

  const glyphs = countGlyphs();
  (window as unknown as Record<string, unknown>).__termStats = {
    cols,
    rows,
    cursorX: buf.cursorX,
    cursorY: buf.cursorY,
    connected,
    glyphs,
  };
}

// Diagnostic helper (used by the headless verifier): count drawn glyphs.
function countGlyphs(): number {
  const buf = term.buffer.active;
  const top = buf.baseY;
  let n = 0;
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(top + y);
    if (!line) continue;
    const { text } = buildRow(line);
    if (text.length === 0) continue;
    for (const run of shapeLogicalRow(resolveFont, text).runs) n += run.glyphs.length;
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
  if (!connected) return;
  const bytes = keyToBytes(e);
  if (bytes !== null) {
    e.preventDefault();
    sendInput(bytes);
  }
});
termWrap.addEventListener('paste', (e) => {
  if (!connected) return;
  const text = e.clipboardData?.getData('text');
  if (text) {
    e.preventDefault();
    sendInput(text);
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

void autoInit();
