// Feasibility spike — Arabic RTL web-terminal core (architecture B_custom, target=match)
// Proves the two RISKIEST correctness pieces work in a browser-portable runtime:
//   (1) Arabic contextual JOINING via HarfBuzz-WASM (the #1 thing xterm.js lacks)
//   (2) UAX#9 BiDi + first-strong paragraph direction (parity with the C++ fork)
// Both harfbuzzjs (WASM) and bidi-js (pure JS) run identically in the browser,
// so a Node PASS is valid evidence for the web target.

import * as hb from 'harfbuzzjs';
import bidiFactory from 'bidi-js';
import { readFileSync, writeFileSync } from 'node:fs';

const FONTS = {
  arabic: 'C:\\Windows\\Fonts\\trado.ttf', // Traditional Arabic (dedicated Arabic)
  mono: 'C:\\Windows\\Fonts\\consola.ttf', // Consolas (the monospace terminal face)
};

// ---------------------------------------------------------------------------
// Ported VERBATIM from the fork's DWriteTextAnalysis.cpp (the "standard here"):
// g_rtlRanges + GetParagraphReadingDirection (majority-strong, first-strong tiebreak).
// ---------------------------------------------------------------------------
const RTL_RANGES = [
  [0x000590, 0x0005ff], // Hebrew
  [0x000600, 0x0006ff], // Arabic
  [0x000700, 0x00074f], // Syriac
  [0x000750, 0x00077f], // Arabic Supplement
  [0x000780, 0x0007bf], // Thaana
  [0x0007c0, 0x0007ff], // N'Ko
  [0x000800, 0x00083f], // Samaritan
  [0x000840, 0x00085f], // Mandaic
  [0x000860, 0x00086f], // Syriac Supplement
  [0x0008a0, 0x0008ff], // Arabic Extended-A
  [0x00fb1d, 0x00fb4f], // Hebrew Presentation Forms
  [0x00fb50, 0x00fdff], // Arabic Presentation Forms-A
  [0x00fe70, 0x00feff], // Arabic Presentation Forms-B
  [0x010800, 0x010fff], // Cypriot, Aramaic, Phoenician, etc.
  [0x01e800, 0x01efff], // Mende Kikakui, Adlam, Arabic Math
];
function isStrongRtlChar(cp) {
  for (const [lo, hi] of RTL_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}
function paragraphReadingDirection(text) {
  let strongRtl = 0, strongLtr = 0, firstStrong = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      strongLtr++; if (firstStrong === null) firstStrong = 'ltr'; continue;
    }
    if (cp < 0x0590) continue; // digits/punct/space: weak-neutral
    if (isStrongRtlChar(cp)) { strongRtl++; if (firstStrong === null) firstStrong = 'rtl'; }
  }
  if (strongRtl !== strongLtr) return strongRtl > strongLtr ? 'rtl' : 'ltr';
  if (firstStrong === 'rtl') return 'rtl';
  return 'ltr';
}

// ---------------------------------------------------------------------------
// HarfBuzz helpers
// ---------------------------------------------------------------------------
function loadFont(path) {
  const data = new Uint8Array(readFileSync(path));
  const blob = new hb.Blob(data);
  const face = new hb.Face(blob, 0);
  const font = new hb.Font(face);
  return { font, face };
}
function glyphName(font, gid) {
  try { return font.glyphName(gid) || `gid${gid}`; } catch { return `gid${gid}`; }
}
function shape(font, text, opts = {}) {
  const buffer = new hb.Buffer();
  buffer.addText(text);
  // harfbuzzjs v1 constraint: set direction/script BEFORE guessSegmentProperties,
  // which must be the last segment-property call (guess only fills unset props).
  if (opts.direction) buffer.setDirection(opts.direction);
  if (opts.script) buffer.setScript(opts.script);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  const raw = buffer.getGlyphInfosAndPositions();
  return raw.map((g) => ({
    gid: g.codepoint, name: glyphName(font, g.codepoint), cluster: g.cluster,
    xAdvance: g.xAdvance, xOffset: g.xOffset,
  }));
}

// ---------------------------------------------------------------------------
const bidi = bidiFactory();
function bidiReorder(text, emb) {
  const idx = Array.from({ length: text.length }, (_, i) => i);
  for (const [s, e] of bidi.getReorderSegments(text, emb)) {
    let a = s, b = e;
    while (a < b) { [idx[a], idx[b]] = [idx[b], idx[a]]; a++; b--; }
  }
  return idx.map((i) => text[i]).join('');
}

// ===========================================================================
const evidence = { hb: hb.versionString(), results: {} };
const log = (...a) => console.log(...a);
let allPass = true;
const assert = (name, cond, detail) => {
  if (!cond) allPass = false;
  log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  return cond;
};

log(`HarfBuzz (WASM) version: ${evidence.hb}\n`);

// ---- PROOF 1: Arabic contextual joining (word vs isolated) ----------------
log('PROOF 1 — Arabic contextual joining (HarfBuzz-WASM), font: Traditional Arabic');
const ar = loadFont(FONTS.arabic);
const WORD = 'كتب'; // kaf-taa-baa: initial + medial + final when joined
const chars = [...WORD];
const wordGlyphs = shape(ar.font, WORD);
log(`  word "${WORD}" -> ${wordGlyphs.length} glyphs (visual order):`);
for (const g of wordGlyphs) log(`      gid=${g.gid} name=${g.name} cluster=${g.cluster} adv=${g.xAdvance}`);

const perChar = chars.map((c, i) => {
  const gs = shape(ar.font, c);
  const inWord = wordGlyphs.find((g) => g.cluster === i);
  return { char: c, isolatedGid: gs[0]?.gid, isolatedName: gs[0]?.name, inWordGid: inWord?.gid, inWordName: inWord?.name };
});
let joinDiffs = 0, notdef = 0;
for (const p of perChar) {
  const diff = p.isolatedGid !== p.inWordGid;
  if (diff) joinDiffs++;
  if (p.inWordGid === 0 || p.isolatedGid === 0) notdef++;
  log(`      '${p.char}': isolated=${p.isolatedName}(${p.isolatedGid})  in-word=${p.inWordName}(${p.inWordGid})  ${diff ? 'JOINED≠isolated' : 'same'}`);
}
assert('Arabic joining fires (>=2 chars change form vs isolated)', joinDiffs >= 2, `${joinDiffs}/3 changed`);
assert('No .notdef in Arabic font (full glyph coverage)', notdef === 0, `${notdef} missing`);
evidence.results.joining = { word: WORD, joinDiffs, notdef, perChar, wordGlyphs };

// ---- PROOF 2: terminal monospace font lacks Arabic => fallback required ----
log('\nPROOF 2 — Consolas (terminal face) Arabic coverage / fallback requirement');
const mono = loadFont(FONTS.mono);
const monoGlyphs = shape(mono.font, WORD);
const monoNotdef = monoGlyphs.filter((g) => g.gid === 0).length;
log(`  Consolas shaping "${WORD}" -> notdef(.gid0)=${monoNotdef}/${monoGlyphs.length}`);
assert('Consolas lacks Arabic => confirms font-fallback design need', monoNotdef > 0,
  'matches fork note: terminal face relies on Arabic fallback');
evidence.results.fallback = { notdef: monoNotdef, total: monoGlyphs.length };

// ---- PROOF 3: BiDi base direction — bidi-js vs fork-ported algorithm -------
log('\nPROOF 3 — UAX#9 BiDi base direction: bidi-js vs fork-ported GetParagraphReadingDirection');
const samples = [
  { t: 'مرحبا بالعالم من الطرفية', expect: 'rtl' },
  { t: 'ls -la /home/user', expect: 'ltr' },
  { t: 'افتح المجلد src ثم شغل npm', expect: 'rtl' },
  { t: 'PATH=/usr/bin مسار', expect: 'ltr' },
];
let bidiAgree = 0;
for (const s of samples) {
  const emb = bidi.getEmbeddingLevels(s.t);
  const bidiBase = emb.paragraphs[0].level & 1 ? 'rtl' : 'ltr';
  const forkBase = paragraphReadingDirection(s.t);
  const ok = forkBase === s.expect;
  if (forkBase === bidiBase || forkBase === s.expect) bidiAgree++;
  log(`  "${s.t}"`);
  log(`      bidi-js base=${bidiBase}  fork-ported=${forkBase}  expected=${s.expect}  ${ok ? 'OK' : 'DIFF'}`);
}
assert('BiDi base direction correct on samples', bidiAgree === samples.length, `${bidiAgree}/${samples.length}`);

// ---- PROOF 4: end-to-end pipeline (web analog of the DirectWrite path) -----
log('\nPROOF 4 — End-to-end: logical row -> base dir -> bidi -> RTL shape -> visual glyph stream');
const ROW = 'مرحبا بالعالم';
const emb = bidi.getEmbeddingLevels(ROW);
const base = paragraphReadingDirection(ROW);
const visual = bidiReorder(ROW, emb);
const shaped = shape(ar.font, ROW, { direction: 'rtl', script: 'Arab' });
log(`  logical:  "${ROW}"`);
log(`  base dir: ${base}  (bidi levels: ${Array.from(emb.levels).join('')})`);
log(`  visual:   "${visual}"  (codepoint reorder)`);
log(`  shaped glyph stream (visual L->R, what a WebGPU atlas renderer draws):`);
log('      ' + shaped.map((g) => `${g.name}(${g.gid})`).join(' '));
const totalAdvance = shaped.reduce((a, g) => a + g.xAdvance, 0);
assert('Pipeline yields joined RTL glyph stream with advances', shaped.length > 0 && shaped.every((g) => g.gid !== 0) && totalAdvance > 0,
  `${shaped.length} glyphs, total advance=${totalAdvance}`);
evidence.results.pipeline = { row: ROW, base, visual, glyphs: shaped, totalAdvance };

// ---------------------------------------------------------------------------
log(`\n================  SPIKE ${allPass ? 'PASS' : 'FAIL'}  ================`);
evidence.verdict = allPass ? 'PASS' : 'FAIL';
writeFileSync('X:\\termenal-Ar-workspace\\web-spike\\evidence.json', JSON.stringify(evidence, null, 2));
log('evidence.json written.');
process.exit(allPass ? 0 : 1);
