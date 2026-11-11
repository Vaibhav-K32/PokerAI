# Implementation plan

| Milestone | Work | Exit criteria |
| --- | --- | --- |
| M0. Study scaffold | Establish the ruleset contract, Hold’em snapshot, evaluator, legal actions, seeded equity worker, responsive form, and local photo review shell. | A sample goes from editable state to results. Invalid cards and unconfirmed photos are rejected. Unit tests run locally. |
| M1. Rules and replay | Add immutable action events, derived street and seat state, automatic pot and commitment tracking, replay, uncalled-chip refunds, and edge-case fixtures. | A known hand replays to the same snapshots and settlement. Invalid actions leave state unchanged. |
| M2. Study models | Add weighted ranges, bounded enumeration or sampling, sample controls, and scenario comparisons. Add explicit opponent response assumptions before ranking bets. | Compare against independently enumerated fixtures. Recommendations explain EV inputs and abstain when the preferred action is sensitive to assumptions. |
| M3. Photo recognition | Collect consented training fixtures and label card crops. Implement a small local recognizer behind the adapter and benchmark representative phones. | Every slot can be edited or left unknown. Report precision and coverage at a chosen abstention threshold. Confirm zero upload and stale-result rejection. |
| M4. Cross-platform release | Add keyboard and screen reader checks, offline upgrade checks, install walkthroughs, and performance measurements on real devices. Add local scenario export with a schema version if needed. | Manual analysis and photo review work on target desktop, iOS, and Android browsers. A cached session loads in airplane mode. |
| M5. Variant proof | Add a scoped Omaha high evaluator plugin and pot-limit betting policy. Evolve the shared contract where fixtures expose missing capability. | Omaha enforces exactly two hole and three board cards, and its fixtures run without changing Hold’em behavior. |

## Test matrix

- **Core unit tests.** All hand categories and tie breakers, wheel straight, board plays, duplicate cards across both players and board, invalid street sizes and chip inputs. Check, capped call, minimum raise, short all-in, no aggression against an all-in opponent.
- **Equity and strategy.** Locked wins/losses/ties, exact outcome counts with blockers, deterministic samples, probability sums, and thresholds at equality. Compare sampled results against exact fixtures and distinguish uncertainty from range assumptions.
- **Capture contract.** Unknown or invalid suggestions, duplicate cards, all candidates requiring confirmation, replacement invalidating stale runs, clear releasing previews, denied or unsupported capture with file picker fallback. Add held-out examples for glare and tilted or partly hidden cards when a model lands.
- **Browser and release.** Run manual and photo flows on current iOS Safari, Android Chrome, and desktop Chromium/Firefox. Verify keyboard flow, 320 px layout, offline reload after caching, worker cancellation, and no image requests in network logs. Target under two seconds for a typical capped equity calculation on a representative midrange phone, then tune the budget from measurements.
- **CI gate once Git hosting is chosen.** Clean install from lockfile, then npm run check. Run browser tests separately as they are added. Require review for rules, probability, capture, and privacy changes.

## Status

M1 rules and replay: the event-driven hand history engine (`src/history/`) replays 2–10 player hands with antes, side pots, uncalled returns, and split pots. It has a demo hand, heads-up, side-pot, and split-pot fixtures, JSON import and export with validation, and a read-only replay view. Remaining M1 work: a form for recording a new hand event by event, and retiring the older heads-up reducer in `src/rules/holdem-replay.ts` once nothing depends on it.

Screenshot import: digital screenshots are read through the Claude endpoint (`layout=screenshot`) behind a provider interface. Users review and correct every field before loading into the study table, saving, or attaching to a matching saved hand. Six synthetic SVG fixtures drive deterministic tests and in-app samples. Next: measure recognition accuracy on a labeled set of consented practice-client screenshots, and add card-region coordinates to highlight detections.

Physical camera recognition (Step 5): Scan table adds photo upload and camera stills, measured photo-quality notes, a Claude `physical` layout with rough positions, table geometry (board and seat grouping, clockwise seats, board axis), configurable chip values with confirmed, estimated, and unknown counts, a full correction workflow, conversion into the shared table state, and photo frames in Track hand. Six staged demo tables and a photo sequence need no API key. Not yet validated: real camera devices and accuracy on real photos. Next: a labeled, consented photo set to measure accuracy, and optional perspective correction.

Frame-to-frame tracking (Step 4): Track hand adds video frame selection, persistent player identity with manual matching and hidden players, identity-aware comparison, consistency classes, replay of frames, verified events, and unresolved gaps, session format v2, and a demo sequence. Video decoding has not yet been exercised in an automated browser test. Earlier, multi-screenshot reconstruction: up to 20 ordered screenshots are read through the screenshot providers in a bounded queue and compared pairwise. Each interval is reconstructed into confirmed facts, unresolved alternatives, and contradictions, and the user can enter actions, which the hand engine validates. The checkpoint timeline, saved and exported sessions, and matching against saved hands are in place. Five synthetic sequences drive the tests. Next: let a fully resolved reconstruction become a saved hand history when the starting stacks and every action are known, and measure recognition accuracy on labeled practice screenshots.

## Suggested next work item

Add a hand recorder that builds events through `actionOptions` and `validateCandidate`, so manual entry and later recognition share one path. Then let a screenshot reader propose board and action candidates from a controlled digital layout for user confirmation, measured against labeled fixtures. Follow with weighted range support.
