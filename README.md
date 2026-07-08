# termenal-web — Arabic / RTL terminal for the browser

A GPU-accelerated terminal emulator for the web that renders **Arabic and other
right-to-left (RTL) scripts correctly** — with contextual letter **joining**
(initial / medial / final / ligature forms) and the Unicode Bidirectional
Algorithm (UAX #9).

It is the browser sibling of
[**termenal-Ar**](https://github.com/sbay-dev/termenal-Ar) (the Arabic edition of
Windows Terminal) and targets the **same Arabic rendering standard**: Arabic
letters connect, RTL paragraphs read from the right, and the underlying text
buffer stays logical while the renderer owns visual presentation.

## Why not just xterm.js?

`xterm.js` is the common web terminal, but as of 2025 it has **no Arabic
shaping** — it draws Arabic letters as isolated, disconnected forms, and its
BiDi support is experimental. termenal-web is designed to be both **stronger**
(correct Arabic joining + BiDi) and **faster** (a WebAssembly VT core plus a
WebGPU glyph-atlas renderer).

## How it works (high level)

| Layer | Technology |
| --- | --- |
| VT parsing + terminal grid | WebAssembly core (Rust `alacritty_terminal` / `vte`) |
| Bidirectional ordering (UAX #9) | `bidi-js` + first-strong paragraph direction |
| Arabic / complex-script shaping | HarfBuzz compiled to WebAssembly (`harfbuzzjs`) |
| Rendering | WebGPU glyph atlas (WebGL2 fallback) |
| Backend I/O | shell bytes over WebSocket (browsers have no PTY) |

## Status

**Early / in design.** Feasibility has been **proven** — see
[`research/arabic-shaping-spike`](research/arabic-shaping-spike), which
demonstrates real Arabic joining and BiDi in a browser-portable runtime. The
public API, WASM core, and renderer are under construction. See
[`docs/specifications`](docs/specifications) for the specification and directives.

## Contributing

Contributions are welcome. This is an open, community edition — please read the
specification in `docs/specifications` first so changes stay aligned with the
Arabic-correctness standard.

## License

MIT — see [LICENSE](LICENSE).
