// load-fonts.js — OUR helper for the Bengali / Devanagari fonts in this
// folder (Noto Sans Bengali, Noto Sans Devanagari; SIL OFL 1.1, see the
// LICENSE-*.txt files). The style kits in core/ are Latin-only: Bengali or
// Devanagari text drawn in a kit font comes out as blank boxes.
//
// How scenes get fonts in this engine (core/engine/player.html): the
// player registers every entry of the scene def's `fonts:` array with
// the FontFace API — { family, src, descriptors } — where `src` is
// resolved against the core/ root, and only THEN runs the scene's
// setup(). The engine's static server serves core/ only, so these files
// cannot be reached from their home in assets/fonts/ — copy what a job
// needs into the job folder first, e.g. `core/sandbox/<job>/fonts/`
// (new files inside the job folder are allowed; core/ itself is never
// edited). Two ways from there:
//
//   1. Declarative (the engine's own mechanism — preferred). In the
//      scene def:
//        fonts: [
//          ...ScriptFonts.entries('sandbox/<job>/fonts/'),
//        ]
//      with this file NOT involved at runtime — entries() is a helper
//      for writing the def by hand; the literal array it returns is
//      what belongs in the scene.
//
//   2. From setup(). Copy this file next to the .woff2 files in the
//      job's fonts/ folder, list it in the scene's `uses:` (as
//      'sandbox/<job>/fonts/load-fonts.js'), then in setup():
//        async setup(env) { await ScriptFonts.load(); ... }
//      load() registers the faces with the FontFace API — the same API
//      the player uses — resolving each file relative to this script's
//      own URL, and resolves once document.fonts.ready settles.
//
// Either way, typeset per text run: Bengali runs in 'Noto Sans Bengali',
// Devanagari runs in 'Noto Sans Devanagari' (weight 700 for headings),
// Latin runs in the style kit's own font.
(function () {
    var FILES = [
        { family: 'Noto Sans Bengali', weight: '400', file: 'noto-sans-bengali-bengali-400-normal.woff2' },
        { family: 'Noto Sans Bengali', weight: '700', file: 'noto-sans-bengali-bengali-700-normal.woff2' },
        { family: 'Noto Sans Devanagari', weight: '400', file: 'noto-sans-devanagari-devanagari-400-normal.woff2' },
        { family: 'Noto Sans Devanagari', weight: '700', file: 'noto-sans-devanagari-devanagari-700-normal.woff2' },
    ];
    // This script's own URL: load() finds the .woff2 files next to it.
    var SELF = (document.currentScript && document.currentScript.src) || '';

    // The def.fonts entries for route 1. `prefix` is the job fonts
    // folder as the player sees it (relative to the core/ root),
    // e.g. 'sandbox/2026-11-01-demo/fonts/'.
    function entries(prefix) {
        return FILES.map(function (f) {
            return { family: f.family, src: prefix + f.file, descriptors: { weight: f.weight } };
        });
    }

    // Route 2: register all four faces now and wait until they are
    // usable. Safe to call more than once (later calls just re-confirm).
    async function load() {
        for (var i = 0; i < FILES.length; i++) {
            var f = FILES[i];
            var ff = new FontFace(f.family, 'url(' + new URL(f.file, SELF) + ')', { weight: f.weight });
            await ff.load();
            document.fonts.add(ff);
        }
        await document.fonts.ready;
    }

    globalThis.ScriptFonts = { families: FILES, entries: entries, load: load };
})();
