# SPEC-0001 — AI directives (executable, code-linked)

Translates the author specifications in
[`../AUTHOR-LINGUISTIC-SPECIFICATIONS.md`](../AUTHOR-LINGUISTIC-SPECIFICATIONS.md)
into concrete engineering directives. Each directive has an acceptance criterion
and links to the code / execution file that implements or verifies it.

Paths under `packages/` and `apps/` are the **planned scaffold targets**; the
directive is the contract that scaffold must satisfy. Links marked ✅ exist today.

---

## D-1 — Arabic contextual joining (SPEC-0001, SPEC-0003)

Arabic text must render with contextual joining (initial/medial/final +
ligatures), driven by an OpenType shaper, never as isolated code points.

- **Implementation:** HarfBuzz compiled to WebAssembly (`harfbuzzjs`), one shaped
  run per script+direction segment. Direction/script are set **before**
  `guessSegmentProperties` (harfbuzzjs v1 ordering constraint).
- **Verify:** shaping a word yields glyph ids that differ from the isolated
  shaping of each letter (≥ 2 of 3 for `كتب`), with no `.notdef`.
- **Code:** ✅ [`packages/shaping/src/index.ts`](../../../packages/shaping/src/index.ts)
  (`loadFont`, `shapeRun`) with tests
  [`packages/shaping/test/shaping.test.ts`](../../../packages/shaping/test/shaping.test.ts);
  original proof [`research/arabic-shaping-spike/spike.mjs`](../../../research/arabic-shaping-spike/spike.mjs) (PROOF 1).

## D-2 — Bidirectional ordering, UAX #9 (SPEC-0001, SPEC-0003)

Rows are reordered per the Unicode Bidirectional Algorithm; paragraph base
direction uses first-strong (majority-strong tiebreak) inherited from
`termenal-Ar`.

- **Implementation:** `bidi-js` for embedding levels + reorder segments; a ported
  `paragraphReadingDirection` using the exact `g_rtlRanges` strong-RTL table.
- **Parity source:** `termenal-Ar` `src/renderer/atlas/DWriteTextAnalysis.cpp`
  (`g_rtlRanges`, `GetParagraphReadingDirection`).
- **Verify:** ported base direction agrees with `bidi-js` and expected result on
  the sample set.
- **Code:** ✅ [`packages/bidi/src/index.ts`](../../../packages/bidi/src/index.ts)
  (`RTL_RANGES`, `paragraphReadingDirection`, `getVisualOrder`) with tests
  [`packages/bidi/test/bidi.test.ts`](../../../packages/bidi/test/bidi.test.ts);
  original proof [`research/arabic-shaping-spike/spike.mjs`](../../../research/arabic-shaping-spike/spike.mjs) (PROOF 3).

## D-3 — Performance: stronger and faster than xterm.js (SPEC-0001)

- **Implementation:** WebAssembly VT core + **WebGPU** glyph-atlas renderer
  (WebGL2 fallback). Zero-overhead LTR fast path: a row with no strong-RTL
  codepoint skips BiDi and RTL handling (mirror of the fork's `w < 0x0590`
  early-out).
- **Verify:** LTR-only rows allocate no BiDi/row-map; frame render stays GPU-bound.
- **Code:** planned `packages/renderer/` (WebGPU), `packages/core/` (WASM).

## D-4 — Component stack (SPEC-0002)

Fixed stack: WASM VT core · `bidi-js` · `harfbuzzjs` · WebGPU renderer · shell
bytes over WebSocket (no browser PTY).

- **Code:** monorepo `packages/`: ✅ `bidi`, ✅ `shaping`, ✅ `terminal`
  ([`packages/terminal/src/index.ts`](../../../packages/terminal/src/index.ts) —
  `analyzeRow` + `shapeLogicalRow` compose bidi + shaping); planned `core`,
  `renderer`, `apps/demo`.

## D-5 — Logical buffer, renderer owns visual (SPEC-0003)

The terminal buffer stays in logical order (copy/paste/screen-reader unaffected);
only the renderer produces visual order + mirrored cursor.

- **Verify:** selecting/copying an Arabic row yields logical code-point order.
- **Code:** ✅ [`packages/terminal/src/index.ts`](../../../packages/terminal/src/index.ts)
  keeps runs in logical order and isolates visual reordering in
  `reorderRunsVisually` / `visualGlyphStream`; planned `packages/core/` (buffer),
  `packages/renderer/` (visual map + mirrored cursor).

## D-6 — Font fallback for Arabic coverage (SPEC-0003)

The monospace terminal face typically lacks Arabic (confirmed: Consolas → all
`.notdef`). A fallback chain must supply Arabic glyphs.

- **Code:** ✅ font-fallback hook `FontResolver` (per-run font selection) in
  [`packages/terminal/src/index.ts`](../../../packages/terminal/src/index.ts) +
  coverage check `hasFullCoverage` in
  [`packages/shaping/src/index.ts`](../../../packages/shaping/src/index.ts);
  original proof [`research/arabic-shaping-spike/spike.mjs`](../../../research/arabic-shaping-spike/spike.mjs) (PROOF 2).

## D-7 — Spike-first + honesty gates (SPEC-0004)

Risky correctness is proven before build; no non-working workarounds; truthful
community text; real `gh` identity on commits.

- **Code:** ✅ [`research/arabic-shaping-spike/`](../../../research/arabic-shaping-spike/) (feasibility proof, `evidence.json`).

## D-8 — VT core selection (SPEC-0005)

Evaluate and choose the WebAssembly VT core.

- **Evaluation result:** `vte` + `alacritty_terminal` grid are pure Rust,
  `no_std`-friendly, and WASM-proven; only PTY/process is replaced with a
  WebSocket byte stream. Rust + `wasm-bindgen` is the most mature WASM path and
  lets us **own the logical cell model** (required by D-5). Ghostty core
  (Zig→WASM, `ghostty-web`) is fast but imposes an xterm-like API and a younger
  embedding story.
- **Decision:** **`alacritty_terminal` (Rust→WASM)** is the chosen core;
  `ghostty-web` is the documented fallback.
- **Code:** planned `packages/core/` (Rust crate + `wasm-bindgen` bindings).
