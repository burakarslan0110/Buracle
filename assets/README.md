# The Buracle logo

The logo is a wordmark only: lowercase "buracle" drawn for Buracle on a square pixel grid. The name joins Burak and *oracle*, so the square bowl of the "b" holds the oracle's slit eye, and that "b" alone is the icon. The terminal draws it with half blocks:

```
██                                       ██
██                                       ██
██▀▀▀▀█▄  ██  ██  ██▄█▀   ▀▀▀█▄  ▄█▀▀▀▀  ██  ▄█▀▀█▄
██ ██ ██  ██  ██  ██      ▄▄▄██  ██      ██  ██▄▄██
██ ██ ██  ██  ██  ██     ██  ██  ██      ██  ██
██▄▄▄▄█▀  ▀█▄▄██  ██     ▀█▄▄██  ▀█▄▄▄▄  ██  ▀█▄▄▄▄
```

| Where | What you see |
|---|---|
| `buracle` menu, 55 columns or wider | the wordmark in a violet-to-fuchsia gradient with an amber eye, then the version and the tagline |
| `buracle` menu, 43 to 54 columns | the icon, the "b" with its eye, with the name, the version and the tagline beside it |
| `buracle` menu when narrower or without color, `buracle install` | one line: `◉ buracle` |
| Install script | the wordmark in the 16-color brand codes from 54 columns, one line below that |
| Buracle Console | the wordmark and "Console" in the top bar, the wordmark alone while the first brain loads; on the person brain the eye turns rose |
| Browser tab | the icon on a dark tile: <img src="../src/memory/ui/favicon.svg" alt="the Buracle icon" width="24" align="top"> |

The tagline is "One engineering setup, one memory, every coding agent", the same on every surface.

## Colors

The body runs from `brand` to `brandEnd`, left to right; the eye is `eye`. The terminal values sit in the middle of the range, so they read on a dark and on a light background. The web values follow the Console's theme.

| Role | Terminal | 256 colors | 16 colors | Web, dark | Web, light |
|---|---|---|---|---|---|
| `brand` | `#8B5CF6` | 99 | 35 (magenta) | `#a78bfa` | `#6d28d9` |
| `brandEnd` | `#D946EF` | 171 | 95 (bright magenta) | `#e879f9` | `#a21caf` |
| `eye` | `#D97706` | 172 | 33 (yellow) | `#fbbf24` | `#b45309` |

The terminal values are `PALETTE` and `ANSI16` in `src/cli/ui/style.ts`, the web values are the `--brand-*` tokens in `src/memory/ui/tokens.css`, and the README badges use the light web values. `tests/cli/ui/brand.test.ts` fails when one copy drifts from the others.

## Changing the logo

The art is kept three times: as `LOGO` in `src/cli/ui/style.ts` (the terminal), in `src/memory/ui/logo.js` (the web UI draws the same rows as pixels) and as `LOGO_ROWS` in `scripts/install.sh` (in ASCII: `#` a full block, `_` a lower half, `^` an upper half). The images are made from `logo.js`: `src/memory/ui/favicon.svg` and the README's `assets/buracle-dark.svg` and `assets/buracle-light.svg`. To change the logo, edit the three copies, then write the images again from the repository root:

```bash
bun -e "import { markTile, wordmarkSvg } from './src/memory/ui/logo.js'; await Bun.write('src/memory/ui/favicon.svg', markTile()); for (const t of ['dark', 'light']) await Bun.write('assets/buracle-' + t + '.svg', wordmarkSvg(t))"
```

`tests/cli/ui/style.test.ts`, `tests/memory/ui-logo.test.ts` and `tests/engine/install-script.test.ts` fail until the copies and the images agree.
