# Codex Project Notes

## Project Overview

This repository is a static browser app for card PDF preparation.

- `index.html`, `app.js`, and `style.css` implement the PDF imposition UI.
- `card-imposer.mjs` implements the command-line card sheet generator used by Project6388.
- `tts.html` and `tts.js` implement Tabletop Simulator deck sheet export.
- `back_default.png` is the default card-back image used by the TTS exporter.
- `.github/workflows/static.yml` deploys the static site to GitHub Pages.

The app runs fully in the browser and loads `pdf-lib` and `pdf.js` from CDNs.
There is no package manager config or local build step in the tracked app.

## Local Files

The Python files and sample PDFs are local helpers or generated test artifacts.
They are currently ignored by `.gitignore` and are not part of the tracked app:

- `layout_cards.py`
- `layout_cards_gui.py`
- `test_*.pdf`
- `screenshot.png`

Do not rely on those files being present in another clone unless the user asks
to restore or formalize the Python tooling.

## Run And Verify

For the static app, open `index.html` or serve the folder with a simple HTTP
server if browser CORS behavior makes local file loading awkward.

Useful verification commands:

```powershell
node --check app.js
node --check tts.js
node --check card-imposer.mjs
```

If you change UI behavior, verify both pages manually:

- `index.html`: load a PDF, adjust card/layout settings, generate the imposed PDF, and check preview/download.
- `tts.html`: load a PDF, assign page roles, generate front/back PNG sheets, and check TTS guide values.

## Important Implementation Details

- PDF dimensions are converted with `MM_TO_PT = 72.0 / 25.4`.
- The browser app uses `pdf-lib` for output PDF generation and `pdf.js` for PDF rendering/previews.
- TTS output uses canvas PNG sheets with a default width of `4096` pixels.
- Keep the app dependency-free unless the user explicitly asks for a build system.
- Preserve the static GitHub Pages deployment model.

## Known Caution

Some Korean UI text appears mojibake-corrupted in the current files. Be careful
when editing text: preserve existing behavior first, and fix encoding or copy
only when that is part of the requested task.
