# assets/fonts — Bengali & Devanagari fonts (ours)

The style kits in `core/` ship Latin-only fonts (Patrick Hand, Shrikhand,
Short Stack…), so any Bengali or Devanagari text a scene draws in a kit
font renders as blank boxes. This folder is **our** layer's fix: two
open-license families with the glyphs those scripts need.

## The fonts

| Family | Weights | Script | License |
|---|---|---|---|
| Noto Sans Bengali | 400, 700 | Bengali (বাংলা) | SIL OFL 1.1 — `LICENSE-Noto-Sans-Bengali.txt` |
| Noto Sans Devanagari | 400, 700 | Devanagari (हिन्दी) | SIL OFL 1.1 — `LICENSE-Noto-Sans-Devanagari.txt` |

- Copyright: The Noto Project Authors
  (https://github.com/notofonts/bengali, https://github.com/notofonts/devanagari).
- Files are the Fontsource builds of the Noto fonts
  (`@fontsource/noto-sans-bengali@5.3.0`, `@fontsource/noto-sans-devanagari@5.3.0`,
  via jsDelivr), subset to their own script — a scene that shows Bengali
  loads the Bengali subset only.
- `fonts.css` holds the matching `@font-face` rules for our own
  pages/tools. Engine scenes don't use the stylesheet — see below.

## How a scene uses them

The engine (`core/engine/player.html`) registers the scene def's
`fonts:` entries itself through the FontFace API, and its static server
serves `core/` only — files in this folder are **not** reachable from a
running scene. So, per job:

1. Copy the `.woff2` files the job needs (and optionally `load-fonts.js`)
   from here into the job folder's own `fonts/` subfolder —
   `core/sandbox/<job>/fonts/`. New files inside the job folder are
   allowed; existing files in `core/` are never edited.
2. Register them, either way:
   - **Declarative (preferred):** add entries to the scene def's
     `fonts:` array, with `src` relative to the `core/` root:
     ```js
     fonts: [
       { family: 'Noto Sans Bengali', src: 'sandbox/<job>/fonts/noto-sans-bengali-bengali-400-normal.woff2', descriptors: { weight: '400' } },
       { family: 'Noto Sans Bengali', src: 'sandbox/<job>/fonts/noto-sans-bengali-bengali-700-normal.woff2', descriptors: { weight: '700' } },
     ]
     ```
     `load-fonts.js` exposes `ScriptFonts.entries('sandbox/<job>/fonts/')`,
     which returns exactly this array for both families — handy when
     writing the def.
   - **From `setup()`:** list `'sandbox/<job>/fonts/load-fonts.js'` in
     the scene's `uses:`, then `await ScriptFonts.load()` inside
     `setup()`. It registers the faces with the same FontFace API the
     player uses, resolving each file relative to its own URL, and
     waits for `document.fonts.ready`.
3. Typeset **per text run**: Bengali runs in `'Noto Sans Bengali'`,
   Devanagari runs in `'Noto Sans Devanagari'` (weight 700 for
   headings), Latin runs in the style kit's own font. Never typeset
   these scripts in a kit font — it has no glyphs for them.

## Adding another script later

Same pattern: drop an OFL family's woff2 files + its license text here,
add `@font-face` rules to `fonts.css` and entries to `load-fonts.js`,
and name the family in the agent instructions.
