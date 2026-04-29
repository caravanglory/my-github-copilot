# mgc — GitHub Copilot Account Manager

A CLI tool for managing multiple GitHub Copilot accounts. Switch between personal, work, and enterprise accounts, monitor quotas, and inspect available models — all from a single interactive menu.

## Installation

```bash
npm install -g mgc
```

Requires **Node.js 18** or later.

## Usage

```bash
mgc
```

The tool opens an interactive menu. On startup it automatically refreshes the quota for every saved account, then shows you the account table and menu.

```
◆  GitHub Copilot Account Manager
│
◇  Quotas updated
│
┌  Accounts ─────────────────────────────────────────────────────────────
│  Name        Status  Last Used  Premium      Chat         Comp
│  ──────────  ──────  ─────────  ───────────  ───────────  ────────────
│  gh-alice    active  today      450/500      ♾️           ♾️
│  work-bob    —       3d ago     80/500       ♾️           ♾️
└────────────────────────────────────────────────────────────────────────

◆  What would you like to do?
●  Add account (OAuth)         GitHub device flow
○  Add account (manual)        Paste token directly
○  Import from auth.json       Auto-detect from OpenCode
○  Check models                Available & disabled models
○  Refresh identity & quota    Update usernames, orgs & quotas
○  Switch account
○  Remove account
○  Remove all accounts
○  Exit
```

Use **↑ / ↓** to navigate, **Enter** to select, **Ctrl+C** to cancel at any prompt.

## Menu Options

### Add account (OAuth)
Authenticate via GitHub's device flow. You will be given a URL and a short code — open the URL in your browser, enter the code, and `mgc` completes the login automatically.

Supports both **github.com** and **GitHub Enterprise Server** (you'll be asked for your enterprise hostname).

### Add account (manual)
Paste an existing OAuth refresh token (e.g. `gho_...`) directly. Useful when you already have a token from another tool.

### Import from auth.json
Reads tokens from `~/.local/share/opencode/auth.json` (or the path you specify) and merges any Copilot entries into the account store. Existing accounts with matching tokens are updated in-place — no duplicates are created.

### Check models
Queries the Copilot API for each account and shows which models are available and which are disabled by your plan or policy.

### Refresh identity & quota
Re-fetches the GitHub username, email, and organisation membership for every account, renames entries to match, and refreshes quota usage.

### Switch account
Picks the active account from a list. Switching writes the chosen account's token to `~/.local/share/opencode/auth.json` so that `opencode` (and compatible tools) pick it up immediately.

### Remove account / Remove all accounts
Removes one or all accounts from the store. Removing the active account automatically promotes the next available account.

## Account Storage

Accounts are stored at:

```
$XDG_CONFIG_HOME/opencode/copilot-x.json   (default: ~/.config/opencode/copilot-x.json)
```

The file is written with mode `0600` (owner read/write only). When you switch accounts, `mgc` also updates:

```
$XDG_DATA_HOME/opencode/auth.json          (default: ~/.local/share/opencode/auth.json)
```

This file is the shared credential store read by `opencode` and compatible tools.

## Quota Display

The account table shows three quota buckets:

| Column   | What it measures                  |
|----------|-----------------------------------|
| Premium  | Premium model interactions        |
| Chat     | Chat requests                     |
| Comp     | Code completion requests          |

Remaining quota is colour-coded: **green** (> 50 %), **yellow** (20–50 %), **red** (< 20 %), **♾️** (unlimited).

## Environment Variables

| Variable                         | Purpose                                          |
|----------------------------------|--------------------------------------------------|
| `XDG_CONFIG_HOME`                | Override config directory (default `~/.config`)  |
| `XDG_DATA_HOME`                  | Override data directory (default `~/.local/share`) |
| `OPENCODE_COPILOT_RETRY_DEBUG=1` | Enable verbose network-retry debug logging       |
| `OPENCODE_COPILOT_RETRY_DEBUG_FILE` | Path for the debug log file                   |

## Development

```bash
git clone https://github.com/caravanglory/my-github-copilot.git
cd my-github-copilot
bun install
bun run build      # compile → dist/index.js
bun run test       # 46 unit tests
bun run typecheck  # TypeScript check
```

To test the CLI locally before publishing:

```bash
npm link           # makes `mgc` available globally from this directory
mgc
npm unlink -g mgc  # remove when done
```

## License

MIT
