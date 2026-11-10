# Poker Study

A local study app for simulated and completed Texas Hold’em hands. It supports no-limit decision snapshots for two to four players (heads-up by default) on desktop and phone, with main and side pots. Its recommendation compares call and fold when the call ends betting, using the opponent model displayed in the result.

## Run locally

Use Node.js 22 or newer and npm. From this directory:

```sh
npm ci
npm run build
npm start
```

Open http://127.0.0.1:4173, choose **Load example**, and select **Analyze hand**. The example has two spades in hand and three on the river board. To set up your own hand, choose **Players in the hand** (2, 3, or 4), tap any card slot on the table to pick a card, and enter each player's stack and bet this street.

### Photo scan with Claude

Photo recognition sends the photo to the Claude API, so the server needs an [Anthropic API key](https://platform.claude.com/). Set it in the shell that starts the server; it never reaches the browser.

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # PowerShell: $env:ANTHROPIC_API_KEY = "sk-ant-..."
npm start
```

Lay the cards face-up in three rows: the opponent’s cards farthest from the camera, the board in the middle, and yours nearest. Open **Scan a photo of the cards**, choose or take a photo, and press **Read cards with Claude**. The cards appear on the table flagged for checking; tap any card to correct it, or choose **All cards match the photo**. Analysis stays blocked until every card is confirmed. Without a key, the app says recognition is unavailable and manual entry still works. Each scan is one paid API request to `claude-opus-5-5`.

Run `npm run check` for TypeScript compilation, build, and automated core tests. The browser shell and all assets are built into `dist/`.

### Hand replay

Select **Hand replay** at the top of the page, then **Load demo hand**. It is a four-handed hand with blinds, betting on every street, a showdown, and the pot award, using fictional players. Step through it with the first, previous, play/pause, next, and last buttons, the speed menu, or the timeline slider. You can also click any event in the list. **Analyze this decision** sends the current decision to the study table. Saved hands stay in this browser. Each hand can be renamed, exported as JSON, imported again, or deleted. See [the engine reference](src/history/HISTORY.md) for the event format, rules, and how recognition modules can plug in later.

### Import a screenshot

Select **Import screenshot**, then drop a PNG, JPEG, or WebP screenshot of a digital table from a simulated or finished hand (up to 12 MB), or choose a file. To try it without an API key, pick one of the built-in samples. Press **Read table**. Real screenshots go to Claude through the app server, so set `ANTHROPIC_API_KEY` as described above; samples use stored results and never call the API. You can cancel while it reads, and a failed scan leaves the study table as it was.

The review screen shows the screenshot (with zoom) beside every recognized field: seats, names, stacks, bets, folded status, hole cards, board, pot, blinds, dealer, and street. Each field is marked High confidence, Needs review, Unknown, or Conflict. Click any card to fix it with the card picker, or mark it unknown. Edit any number, and mark your seat and the dealer. Problems such as duplicate cards or an impossible board block importing until they are fixed. Then choose **Load into study table**, **Save for later** (the image is kept only if you tick the box), or **Attach to hand** to link it to a saved hand it matches, and **Open in hand review**. Details and limits: [src/vision/SCREENSHOTS.md](src/vision/SCREENSHOTS.md).

## Phone and offline use

For a phone trial, serve `dist/` from an HTTPS static origin the phone can reach. First load it while connected and give the service worker time to cache the app before checking an offline reload. Use your browser’s install or home screen option if available. The file picker works as the fallback on browsers that do not support direct photo capture. The local development server listens on loopback by default. A static host has no `/api/recognize` endpoint, so photo recognition works only through `npm start` (or another server that mounts `scripts/recognize.mjs`); browsers allow camera capture on a phone only over HTTPS.

## Project map

- [Specification](SPEC.md) covers product boundaries, data contracts, decision assumptions, and capture privacy.
- [Implementation plan](PLAN.md) covers milestones, the test matrix, and the next work item.
- [Repository instructions](AGENTS.md) and [Claude Code entry point](CLAUDE.md) define how to divide and review tasks.
- `src/core/` holds state, the plugin registry, and equity. `src/rules/` holds Hold’em rules. `src/history/` holds the hand history and replay engine (pure, no browser APIs). `src/vision/` holds the photo and screenshot recognition contracts, providers, review checks, and synthetic screenshot fixtures. `scripts/recognize.mjs` is the server-side Claude API endpoint. `src/web/` and `web/` hold the table interface and worker entry points.

The folder is ready to put under Git. Start each coding agent from this directory so it picks up the project instructions.
