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

## Suggested next work item

Implement a pure heads-up replay reducer with fixed action-history fixtures. Own the core and its unit tests in one branch. Preserve the existing snapshot API so the UI continues working. Follow with weighted range support and a separate capture benchmark.
