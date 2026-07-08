# Arabic shaping + BiDi feasibility spike

This is the **feasibility proof** behind `termenal-web`. It demonstrates, in a
browser-portable runtime, the two hardest correctness pieces required to match
the `termenal-Ar` Arabic standard:

1. **Arabic contextual joining** via HarfBuzz compiled to WebAssembly
   (`harfbuzzjs`).
2. **Bidirectional ordering (UAX #9)** via `bidi-js`, plus a paragraph
   base-direction function ported verbatim from `termenal-Ar`
   (`g_rtlRanges` + `GetParagraphReadingDirection`).

Both dependencies (`harfbuzzjs` = WASM, `bidi-js` = pure JS) run identically in
the browser, so a Node pass is valid evidence for the web target.

## Run it

```bash
npm install
npm run spike
```

Expected: `SPIKE PASS`, and an `evidence.json` is (re)written. A committed
`evidence.json` from the original run is included for reference.

## What it proves (see console output)

| Proof | Result |
| --- | --- |
| P1 — Arabic joining (`كتب`: 3/3 letters change to connected forms) | PASS |
| P2 — Consolas has no Arabic → font-fallback is required | PASS |
| P3 — Ported base-direction matches `bidi-js` (4/4 samples) | PASS |
| P4 — End-to-end row → base dir → BiDi → RTL shape → visual glyph stream | PASS |

## Notes

- **Fonts:** `spike.mjs` loads Windows system fonts
  (`C:\Windows\Fonts\trado.ttf` for Arabic, `consola.ttf` for the monospace
  face). On other platforms, edit the `FONTS` paths to point at any
  Arabic-capable font and a monospace font.
- **harfbuzzjs v1 constraint:** set `setDirection` / `setScript` **before**
  `guessSegmentProperties` (which must be the last property call); otherwise the
  buffer stays unshaped (glyph ids equal code points, zero advance).
- This is research/evidence, not production code. The production shaping and BiDi
  layers live under `packages/` (see `docs/specifications`).
