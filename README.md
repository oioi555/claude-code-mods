# claude-code-mods

oioi555's Claude Code mods. The repository is itself a marketplace, named `oioi555`.

| Mod | What it does |
| --- | --- |
| [cache-keeper](plugins/cache-keeper/) | Shows context, quota and prompt-cache meters. While a session on a 1-hour cache is idle, it keeps the cache alive, then compacts before the cache lapses, holding off system sleep meanwhile (Linux, Windows, macOS). |

## Installing

Requires Claude Code 2.1.287 or later, where mods are on by default.

```sh
claude plugin marketplace add oioi555/claude-code-mods
claude plugin install cache-keeper@oioi555
```

To update:

```sh
claude plugin marketplace update oioi555
claude plugin update cache-keeper@oioi555
```

Then run `/reload-plugins` to bring the update into a running session.

### Mods this replaces

cache-keeper covers what these mods did. Disable them, or the meters show up twice:

- `cache-ttl-compact@oikawa-local` (cache-keeper's predecessor)
- `prompt-cache-control@skills-dir` (cache meter)
- `usage-meter@claude-mods` (context and quota meter)

## Development

On the development machine, the working copy itself is added as a marketplace (`claude plugin marketplace add ~/git/claude-code-mods`). Claude Code reads a folder marketplace straight from the working copy, so `/reload-plugins` picks up an edit.

```sh
claude plugin validate plugins/cache-keeper
claude plugin test plugins/cache-keeper
# Try it in one session with hot reload
claude --plugin-dir plugins/cache-keeper
```

Claude Code writes the API types to `.claude-plugin/types/` each time it loads the mod. `plugins/cache-keeper/tsconfig.json` points at them, so after the mod has loaded once, type-check with `npx -p typescript tsc -p plugins/cache-keeper`.
