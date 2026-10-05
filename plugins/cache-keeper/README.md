# cache-keeper

A Claude Code mod that draws two rows of meters above the prompt. When a session on a 1-hour prompt cache goes idle, it keeps the cache alive and then compacts the session before the cache lapses.

```
ctx ░░░░░░░░░░ 2% 20.5k/1M ▸auto 967k · 5h 28% ↻2h31m · 7d 67% ↻2d5h
● cache 60% ⏱ 59:41 1h · keep-alive 54:41 → compact 1:49:41 · sleep held
```

- Row 1 shows how full the context window is and the token count at which Claude Code compacts on its own (`▸auto`). It also shows how much of the 5-hour and 7-day plan windows is used and when each resets.
- Row 2 shows the cache hit rate, the time left before the cache expires, the cache lifetime (5m or 1h) and the keeper's schedule. `sleep held` means system sleep is blocked.

The band keeps up while you are away. After a keep-alive the countdown starts again. After a compact, whether the keeper's, `/compact` or Claude Code's own, the band says so until the next response brings real figures:

```
ctx -- (compacted 24.6k → 3.2k) ▸auto 167k · 5h 9% ↻3h51m · 7d 72% ↻1d15h
○ cache -- 1h · compacted while idle 12m ago
```

`/ttl` opens a pane with the full details: cache, context, quota and keeper state, a table with one row per turn, and buttons.

| Command | What it does |
| --- | --- |
| `/ttl` | Opens the pane (buttons: `k` keep-alive now, `c` compact now, `p` pause/resume) |
| `/ttl pause` / `/ttl resume` | Pauses or resumes the keeper for this session |
| `/ttl now` | Runs a keep-alive right away |
| `/ttl compact` | Compacts right away |
| `/ttl stop` | Closes the pane |

## How the keeper works

The keeper arms when a main turn completes. The cache lifetime counts from the **start** of the last request that read or wrote the cache.

1. `marginMinutes` before the cache expires (5 by default), it sends one tool-less, one-character `$.model.fork()` request. The request reads the same conversation prefix, so the cache lives another hour from that point.
2. After `keepAlives` keep-alives (1 by default), it compacts the session with `$.session.compact()` before the next expiry.
3. A prompt from you cancels whatever is pending.

It does nothing in two cases:

- When the cache lifetime is 5 minutes (an API key, a cloud provider or usage credits). A keep-alive every 5 minutes costs more than it saves.
- When the cache has already expired by the time the keeper gets to run (for example, the machine was asleep). A keep-alive then would only pay to write the whole cache again.

### Sleep hold

While a keep-alive or compact is pending, the mod keeps one platform-specific process running through `$.process.spawn`. When nothing is pending or the session ends, it ends the process, and the hold goes with it.

| OS | How | Check |
| --- | --- | --- |
| Linux | `systemd-inhibit --what=idle:sleep --mode=block` | `Claude Code cache-keeper` in `systemd-inhibit --list` |
| Windows | `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` from PowerShell | `powercfg /requests` in an elevated PowerShell |
| macOS | `caffeinate -i` | `pmset -g assertions` |

On Windows and macOS this blocks idle sleep only. Closing the lid or putting the machine to sleep by hand still works. On Linux, `--mode=block` also blocks a manual suspend.

## How the cache lifetime is decided

With `ttl` set to `auto`, the mod applies Claude Code's own rules in this order:

1. `FORCE_PROMPT_CACHING_5M` → 5 minutes
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` (`5m` / `1h`)
3. The `promptCacheTtl` setting
4. `ENABLE_PROMPT_CACHING_1H` → 1 hour
5. A subscription (the account has 5-hour or 7-day plan windows) → 1 hour; anything else → 5 minutes

A new session has no quota data until its first response arrives. Until then, the mod uses the plan windows an earlier session saw, which it keeps in `$.store`.

After that, the gaps between requests also correct the lifetime. A cache hit after a gap of more than 5 minutes confirms 1 hour. A miss after a gap of 5 to 60 minutes means 5 minutes.

## Options

Change these in Claude Code's config menu (the plugin's rows under `/config`). A change reloads the mod.

| Option | Default | Meaning |
| --- | --- | --- |
| `ttl` | `auto` | `auto`, `5m` or `1h` |
| `marginMinutes` | 5 | How many minutes before expiry the keep-alive or compact runs |
| `keepAlives` | 1 | Keep-alives before the compact (0 compacts at the first deadline) |
| `keeper` | true | Run keep-alives and compacts (false leaves only the meters) |
| `inhibitSleep` | true | Block idle sleep while a keep-alive or compact is pending |
| `band` | true | Show the two rows above the prompt |
| `quota` | true | Show the plan windows in the band |
| `status` | false | Also show a short entry in the status line |

## Verified / not yet verified

Verified on 2026-10-05 (Claude Code 2.1.289, Manjaro):

- `claude plugin validate` passes, and all 23 tests in `claude plugin test` pass. The tests run on a mocked clock and cover:
  - a keep-alive, then a compact, over 1 hour 50 minutes idle
  - the band after that compact, and how long ago it ran
  - `/ttl compact`
  - the countdown starting again with no `session.start` (a reload)
  - your return cancelling the keeper
  - skipping a cache that already expired
  - the countdown and keeper continuing after the mod reloads
  - drawing the band and pane on the terminal and the desktop
- In a live session:
  - the band and pane draw
  - `/ttl now` really refreshes the cache (read 20.2k tokens, 98% hit)
  - after `/ttl compact` and `/compact`, the band switches to `--` and the compact at once, and the elapsed time advances while idle (Claude Code 2.1.289, 2026-10-06)
  - the Linux sleep hold is taken while waiting and released when the session ends

Not yet verified:

- The sleep hold on Windows and macOS (check `powercfg /requests` or `pmset -g assertions` on real machines)
- The automatic keep-alive and compact after a real 55- and 110-minute wait

## License

[MIT](LICENSE)
