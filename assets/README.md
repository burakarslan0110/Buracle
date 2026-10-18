# The Buracle logo

The logo is a lowercase wordmark drawn for Buracle on a square pixel grid. The name joins Burak and *oracle*, so the bowl of the "b" holds the oracle's eye, and that "b" alone is the icon. The terminal draws it with half blocks:

```
██                                             ██
██                                             ██
██████▄   ██    ██  ██▄███   ▄██████   ▄█████  ██   ▄████▄
██ ▄▄ ██  ██    ██  ██▀     ██    ██  ██       ██  ██▄▄▄▄██
██ ▀▀ ██  ██    ██  ██      ██    ██  ██       ██  ██▀▀▀▀▀▀
██████▀    ▀██████  ██       ▀██████   ▀█████  ██   ▀█████
```

| Where | What you see |
|---|---|
| `buracle` menu, 62 columns or wider | the wordmark in a violet-to-cyan gradient with a cyan eye, then the version and the tagline |
| `buracle` menu, 43 to 61 columns | the icon, with the name, the version and the tagline beside it |
| `buracle` menu when narrower or without color, `buracle install` | one line: `◉ buracle` |
| Brain web UI | the wordmark and "Brain" in the top bar, the wordmark alone while the first brain loads; on the personal brain the eye turns rose |
| Browser tab | the icon on a dark tile: <img src="../src/memory/ui/favicon.svg" alt="the Buracle icon" width="24" align="top"> |

The art is kept twice, as `LOGO` in `src/cli/ui/style.ts` (the terminal) and in `src/memory/ui/logo.js` (the web UI draws the same rows as pixels). The images are made from it: `src/memory/ui/favicon.svg` and the README's `assets/buracle-dark.svg` and `assets/buracle-light.svg`. To change the logo, edit both copies of `LOGO`, then write the images again from the repository root:

```bash
bun -e "import { markTile, wordmarkSvg } from './src/memory/ui/logo.js'; await Bun.write('src/memory/ui/favicon.svg', markTile()); for (const t of ['dark', 'light']) await Bun.write('assets/buracle-' + t + '.svg', wordmarkSvg(t))"
```

`tests/cli/ui/style.test.ts` and `tests/memory/ui-logo.test.ts` fail until the two copies and the images agree.
