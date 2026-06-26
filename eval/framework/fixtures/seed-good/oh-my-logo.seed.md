# SEED: oh-my-logo

A small Node CLI that renders a line of text as a big ASCII-art logo and paints it
with a colorful gradient. Prose-first essence capture — describe what it does and how
it's built, not the source.

## What it is

A command-line tool, published as an npm package with a `bin`, invoked as
`oh-my-logo <text> [palette] [options]`. Given some text it prints a large figlet-style
ASCII rendering to stdout, colorized with a named gradient palette. With no palette it
uses a sensible default; with `--list-palettes` it prints the catalog of built-in
palettes and their colors instead of rendering.

## Behavior to reproduce

- **Render (core action).** `oh-my-logo "OH MY LOGO"` prints multi-line ASCII art on
  stdout (figlet "Standard"-style glyphs), gradient-colored. Exit 0.
- **Palette selection.** The second positional argument names a built-in palette
  (e.g. `oh-my-logo HELLO sunset`). There are 13 built-ins; their names include
  grad-blue (the default), sunset, dawn, nebula, mono, ocean, fire, forest, gold,
  purple, mint, coral, matrix.
- **List palettes.** `--list-palettes` prints each palette name with its hex colors
  joined by an arrow, and does not render a logo.
- **Filled mode.** `--filled` switches to solid block glyphs (a React/Ink renderer)
  instead of outline figlet; `--letter-spacing N` and `--block-font NAME` tune it.
- **Errors.** An unrecognized palette name fails with a clear message of the form
  "Unknown palette: <name>" and a non-zero exit. Bad input and missing fonts fail
  similarly with their own messages.

## How it's built

- TypeScript, compiled with `tsc` to `dist/`; the CLI entry is `dist/index.js`.
- Outline rendering uses the `figlet` library for glyphs and `gradient-string` for the
  color gradient across the rendered block. Filled mode uses `ink` + `cfonts`.
- Argument parsing uses `commander`. Color/TTY behavior respects `NO_COLOR`/`FORCE_COLOR`.
- A small library surface (`render`, `renderFilled`, `resolveColors`, the palette
  lookup helpers) backs the CLI so the same capability is usable programmatically.

## Build & verify

`npm ci && npm run build`, then `node dist/index.js "HELLO" sunset` should print
gradient ASCII art, and `node dist/index.js --list-palettes` should list the 13 palettes.
