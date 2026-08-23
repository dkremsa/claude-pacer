# Claude Pacer

A macOS menu-bar number that tells you whether your Claude subscription will last until the reset — and what to change if it won't.

<img src="docs/icon.png" width="96" align="right">

**⏱ 133** — the worst limit window's projected % at its reset, at the speed you've shown so far.
100 = you run out exactly at reset. Green ≤ 80, amber ≤ 100, red above.

Click it:

```
● Session      44% used     54  at reset
● Week         16% used    133  at reset
● Fable week   12% used    116  at reset
──────────────────────────────────────────
To fit the week: use Fable about 58% less
──────────────────────────────────────────
On the API this would have cost  $62 today · $410 this week
```

## What's different

Every other menu-bar tool shows the percent. Pacer shows the **speed**: where you land at reset if you keep going like this. 16% used sounds fine — until you notice it's 10% into the week.

- **One sentence of advice.** Computed from your actual model mix: stop/reduce Fable, move X% of Opus work to Sonnet, or do less. "On pace — nothing to change" when you're fine.
- **Per-model weights measured on your own account.** Anthropic doesn't publish how Opus/Sonnet/Fable count against the limits. Pacer joins the official usage % with your local transcripts and fits the weights from the data (and whether cache reads are discounted). Until there's enough data it uses API price ratios.
- **API-equivalent cost**, so you know what the subscription is worth to you.
- **Notifications** when the pace crosses 100, when it comes back, and when any window passes 90%.
- Tiny. One Node script (no dependencies) + one Swift file. The data is a JSON file other tools can read.

## Install

Requires macOS 13+, Node ≥ 18, Xcode Command Line Tools (`xcode-select --install`), and a Claude Code login (it reads the same credential `/usage` uses).

```sh
brew install dkremsa/tap/claude-pacer
brew services start claude-pacer          # samples every 10 min, survives reboots
cp -R "$(brew --prefix)/opt/claude-pacer/Claude Pacer.app" /Applications/ && open "/Applications/Claude Pacer.app"
```

Or from source: `git clone https://github.com/dkremsa/claude-pacer.git ~/.claude/pacer && cd ~/.claude/pacer && ./build.sh` — compiles the app into `/Applications` and installs a launchd agent that samples every 10 minutes.

**Start at login:** System Settings → General → Login Items & Extensions → **+** → pick **Claude Pacer** from Applications. The sampler already runs at boot; this is for the menu-bar icon.

## For other tools

`~/.claude/pacer/status.json` is refreshed every 10 minutes: `pace`, `level`, `advice`, `windows[]` (used %, speed, projected, hours left), `cost`, `fit`. `node pacer.mjs status` prints the same.

## How the number is made

- Week windows: `projected = used% / fraction of the window elapsed`.
- The 5-hour session: rate over the last 45 minutes, projected to the reset (a session is bursty; an average since it opened lags).
- The headline is the worst window.

Works on Pro, Max and Team. Claude only. Nothing leaves your machine.
