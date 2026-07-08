# Author linguistic specifications — termenal-web

**Author:** sultanAalyami (`@sultanAalyami`)
**Repository:** `sbay-dev/termenal-web`
**Related standard:** `sbay-dev/termenal-Ar` (Arabic edition of Windows Terminal)
**Status:** active — feasibility proven, implementation in design.

This document records the author's specifications **verbatim**. Each
specification is translated into executable, code-linked directives in
[`directives/SPEC-0001-AI-DIRECTIVES.md`](directives/SPEC-0001-AI-DIRECTIVES.md).

---

## SPEC-0001 — Core request (verbatim)

> نريد توفير تيرمينال يدعم اللغه العربية بنفس المقاييس التي هنا مخصص للمتصفحات
> هل يمكن بناء حزمه مخصصه للويب xterm هو المرشح الحالي لكن نريد تيرمينال بخصائص
> اقوى واسرع

**Normalized statement.** Provide a browser terminal that supports Arabic with
the **same standard as `termenal-Ar`**. `xterm.js` is the current candidate, but
the product must be **stronger and faster**.

→ Directives: **D-1, D-2, D-3** (Arabic joining, BiDi, performance).

---

## SPEC-0002 — Architecture decision (resolved)

Chosen architecture: **B_custom** — a new browser terminal built from:
a WebAssembly VT core + a custom **WebGPU** renderer + **HarfBuzz-WASM** shaping
+ **BiDi (UAX #9)**. `xterm.js` is rejected as the base because it has **no
Arabic shaping** (isolated forms only), which is weaker than what `termenal-Ar`
already ships.

→ Directives: **D-4** (component stack), **D-8** (VT core selection).

---

## SPEC-0003 — Arabic quality target (resolved)

**Match the current `termenal-Ar` standard**, defined precisely as:

- Arabic letters **join** (initial / medial / final / ligature forms fire).
- Paragraph base direction is chosen by **first strong character** (with the
  majority-strong rule inherited from `termenal-Ar`).
- The terminal **text buffer stays logical**; the **renderer owns visual
  presentation** (visual cursor mirroring, RTL paragraph from the right edge).

**Out of scope for v1** (explicitly, as in `termenal-Ar`): full per-cell visual
RTL ordering of mixed LTR/RTL rows and bracket mirroring — the open
`microsoft/terminal#538` cell-ownership problem.

→ Directives: **D-1, D-5, D-6**.

---

## SPEC-0004 — Working method (inherited boundary rules)

- **Root-cause only**; no filler or workaround hacks. Do not build things that
  do not actually work — if a goal is technically impossible, say so and stop.
- **Prove the risky parts first** (feasibility spike) before large build work.
- **Truthful community language** in customer/community-facing text; no
  overclaiming.
- Commit with the author's **real, verified Git identity** (derived from the
  authenticated `gh` account) — never placeholder identities.

→ Directives: **D-7** (spike-first + honesty gates).

---

## SPEC-0005 — Delivery (resolved)

- New **public** repository `sbay-dev/termenal-web`.
- Sequence: **specification first, then scaffold.**
- VT core: **evaluate** candidates and recommend (Ghostty core vs
  `alacritty_terminal`).

→ Directives: **D-8** (VT core evaluation + recommendation).
