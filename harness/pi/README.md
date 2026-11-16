# buracle-pi

Buracle Stack's files for Pi. `buracle build` **generates** this directory from `canonical/` and `src/adapters/pi/`; do not edit it by hand.

- `extensions/buracle.js`: the extension, one file (src/core plus the Pi runtime). `buracle install pi` copies it to `<agent dir>/extensions/buracle.js`. It runs the tool guards, consent, routing, the stop guard, prompt routing, the session context and the memory capture through the shared hook pipeline.
- `mcp.json`: the MCP servers `buracle install pi` merges into Pi's own `mcp.json`: `buracle-memory`, `chrome-devtools`, `codegraph`, `context7`, `grep`, `semble`, `web-fetch`, `web-search`.

Needs Pi 1.5.2 or newer. Skills are not in this folder: Pi reads `~/.agents/skills` itself. `buracle doctor pi` checks the version, the extension and the MCP entries.
