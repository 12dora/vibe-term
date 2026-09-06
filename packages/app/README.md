# vibeterm-cli

Node.js-compatible CLI that installs, diagnoses, upgrades, and uninstalls VibeTerm.

Install from GitHub Releases:

```bash
curl -fsSL https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh | bash
```

Commands:
- `vibeterm init`
- `vibeterm doctor`
- `vibeterm upgrade`
- `vibeterm uninstall`
- `vibeterm hub …` / `vibeterm relay …` (mesh and relay management)

Install directory: `~/Library/Application Support/vibeterm` (macOS) or `~/.local/share/vibeterm` (Linux);
database at `data/vibeterm.db`, configuration in `app.env` (`VIBETERM_*` keys).

Installs created by the previous release name (`tmex`) are moved to the new directory on upgrade,
and `tmex` remains available as an alias for `vibeterm`.

Use `--lang en` or `--lang zh-CN` to switch CLI language.
