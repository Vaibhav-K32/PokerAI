# Multi-screenshot hand reconstruction

Reconstruct hand turns several screenshots of one simulated or finished hand into a checkpoint timeline. Each screenshot is one observed moment. The app compares neighbouring screenshots and lists what changed. It never invents the actions in between: an action becomes an event only when you enter it and the hand engine accepts it. This is an offline study tool, not live-game assistance.

## Pipeline

```
Upload (several files, drag and drop, or a sample sequence) → order (↑ ↓, drag, or restore upload order)
→ per screenshot: image checks → resize and re-encode → screenshot provider (Claude or fixture), two at a time
→ schema validation (parseScreenshotResponse) → HandObservation
→ review and correction (shared editor) → compareObservations for each neighbouring pair
→ reconstructHand: checkpoints, intervals, timeline, metrics → your resolutions → save, export, match saved hands
```

| File | Role |
| --- | --- |
| `types.ts` | `HandObservation`, `StateDifference`, `Interval`, `ManualAction`, `IntervalResolution`, `ReconstructionResult`, `ReconstructionSession` |
| `observation.ts` | Creating, correcting, and restoring observations; chip totals that stay `null` when anything is unknown |
| `compare.ts` | `alignSeats`, `compareObservations`: the difference engine |
| `reconstruct.ts` | `reconstructHand`, `matchHistory` |
| `resolve.ts` | `checkpointState`, `checkActions`: user actions through the hand engine |
| `session.ts` | Ordering helpers, `createSession`, `serializeSession`, `parseSession` |
| `queue.ts` | `RecognitionQueue`: bounded concurrency, retries, stale-result protection |
| `fixtures.ts` | Five synthetic sequences |

Everything in `src/reconstruction/` is pure TypeScript without browser APIs. The interface is `src/web/reconstruct-view.ts`, with `table-view.ts` (the table shared with hand replay) and `recognition-editor.ts` (the correction form shared with Import screenshot).

## Upload and order

- **Limits:** up to `MAX_SCREENSHOTS` (20) PNG, JPEG, or WebP files of at most 12 MB and 200–16,384 px per side. Files past the limit are skipped with a message.
- **IDs and order:** each screenshot gets a stable ID when added and keeps its upload position (`uploadIndex`). The chronological order is whatever you set; file names and file times are never used.
- **Reordering:** reordering re-numbers the observations. A resolution survives only while its two screenshots stay next to each other.

## Recognition

- **Batch reading:** **Read screenshots** queues every unread screenshot. `RecognitionQueue` runs two requests at a time and reports totals, finished, in progress, failed, and stopped screenshots.
- **No repeated requests:** a recognized screenshot is never sent again in the same session. A failed one can be retried on its own.
- **Late results:** a result arriving after the screenshot was removed or the batch was cancelled is dropped, so it cannot overwrite your corrections.
- **Providers and keys:** each screenshot uses the same providers as Import screenshot. The API key stays on the server.

## Observations

A `HandObservation` wraps the screenshot's `ScreenshotRecognition`:

- **Field values:** every field keeps its value (`null` for unknown), the reader's confidence label, and its source (observed, inferred, or corrected).
- **Review status:** it is `pending`, `reviewed`, or `corrected`. It becomes `corrected` as soon as any field is edited.
- **Timestamps:** `timestamp` stays `null` unless supplied; nothing is taken from files.
- **Missing values:** a missing value is never read as a fold or a departure.

## The difference engine

`compareObservations(previous, next)` lines seats up by name, allowing a rotated view, and reports differences in a fixed order. Each difference has:
- the field;
- the earlier and later values;
- both observation IDs;
- an evidence class (observed, inferred, or includes a correction);
- both confidence labels;
- a severity: `info`, `review` (possible but unusual), or `contradiction` (impossible within one hand);
- an optional warning.

What it reports:
- **Board:** new flop, turn, or river cards; more than one street at once (flagged); cards becoming readable or unreadable; a changed card or a shrinking board (contradictions).
- **Chips:** pot plus bets, and each stack and bet. A growing stack is marked for review.
- **Players:** folds, a folded player back in the hand (contradiction), hole cards shown, changed (contradiction), or hidden, seat count changes, and seat names that do not line up.
- **Table:** street changes and a street going backwards; a moved dealer button and changed blinds, both contradictions that suggest different hands.

A value missing on either side is not a change. It is reported only as becoming visible or hidden.

## Reconstruction

`reconstructHand(observations, { resolutions })` returns checkpoints, intervals, a timeline that alternates them, contradictions across the whole sequence, warnings, and metrics. Each interval separates three kinds of finding:

- **Confirmed:** facts the screenshots show, such as "Turn dealt: Kh", "Riley’s stack fell from 990 to 970", or "Sam is shown as folded". Two rules also confirm facts. Unchanged stacks while the board advanced mean only checks happened. A run-out with at most one player holding chips means no more betting.
- **Possible:** for example, "An additional 60 chips appear in the middle between these screenshots. The contributing actions are unknown." Other examples are who could have contributed, skipped streets, and possible pot awards. These are alternatives, never facts, and no events are produced from them.
- **Contradictions:**
  - impossible differences between the two screenshots;
  - chip totals that differ, since no action creates or removes chips and rake is not modeled;
  - a card in two places, or one player shown with more than two different cards;
  - duplicate cards or impossible boards within one screenshot.

| Interval status | Meaning |
| --- | --- |
| No change / Verified | Nothing changed, or every change is accounted for |
| Unresolved | Chips moved, or may have moved, without known actions |
| Left unresolved | You accepted that the actions stay unknown |
| Resolved / Partly resolved | Your confirmed actions explain all, or only part, of the change, or one is invalid |
| Contradiction | Needs a correction, or a decision that these are different hands |
| Different hands | You marked the pair as two hands; their contradictions are not counted |

## Resolving an interval

You can do any of these, in any combination:
- leave it unresolved;
- enter known actions;
- correct values in either screenshot;
- mark the pair as different hands;
- revalidate.

Saving never requires an interval to be resolved.

Entered actions are checked by `checkActions`:

1. **Starting state:** `checkpointState` turns the earlier screenshot into a betting state. Every live seat's stack and bet must be known. What a screenshot cannot show is set to the most permissive legal value: nobody has acted on the street yet, and the last raise is one big blind.
2. **Each action:** it goes through the hand engine's `applyHandEvent`. The engine checks amounts to call, stacks, minimum bets and raises, and folded or all-in players. Turn order is not checked, because screenshots do not show it.
3. **Next street:** if your actions close the betting round and the later screenshot shows the next board cards, that observed deal is applied.
4. **Comparison:** the result is compared with the later screenshot. Unexplained chips, unentered folds, and conflicts are listed.

Valid actions become executable `HandEvent`s whose timestamps record when you entered them. **Step through these actions** replays them on the table. Nothing else is animated.

## Timeline, saving, and history

- **Timeline:** it shows each checkpoint (street, board, pot, stacks, review state) and each interval (status, summary, counts). First, previous, next, last, and the slider move between checkpoints with `moveCursor`. Clicking an interval selects its later screenshot.
- **Saving:** **Save reconstruction** stores a `ReconstructionSession` in `localStorage` (`poker-study:reconstructions`): ID, schema version 1, title, times, screenshot order, observations with corrections, resolutions with confirmed actions, and warnings. Images are saved only when you tick **Also save the screenshot images**. Otherwise reopening restores the timeline and corrections, but not the screenshots.
- **Managing saved sessions:** saved reconstructions can be opened, renamed, exported as JSON, imported, and deleted. `parseSession` validates everything and recomputes warnings.
- **Saved hands:** **Check against saved hands** uses `matchHistory`. It looks for one replay position per screenshot, in order and with one seat rotation, using the hand history engine's `matchObservation`. It can then open the matching hand in hand review at the selected screenshot.

## Quality summary

The summary counts screenshots, recognized checkpoints, corrected fields, verified transitions (verified or resolved intervals), unresolved intervals, and contradictions. It does not show an accuracy percentage, because that needs labeled ground truth. Confidence labels are the reader's own uncalibrated estimates.

## Fixtures

`fixtures.ts` holds five synthetic sequences drawn by this project and read by the fixture provider:
1. **Complete hand:** five frames from preflop to showdown, three players.
2. **Missing street:** preflop, then the turn.
3. **Ambiguous betting:** the pot grows from 60 to 120 while two stacks are unreadable.
4. **Recognition error:** a 7♣ misread as a 7♠.
5. **Multiway all-in:** three players, one side pot. The test checks it against the engine's own settlement.

## Toward physical tables

The pipeline needs only a `ScreenshotProvider` that returns a `ScreenshotRecognition`. A camera or on-device provider can feed the same queue, comparison, reconstruction, and review screens without changing the hand history engine.

## Limitations

- **Seat matching:** seats are matched by order and visible names. With no readable names, a rotated client view cannot be detected.
- **Pot detail:** side pots shown separately on screen are read as one pot, and rake is not modeled.
- **Unknown stacks:** actions cannot be checked when a live seat's stack or bet is unknown in the earlier screenshot.
- **Turn order and raise size:** turn order is not validated, and the minimum raise assumes the last raise was one big blind.
- **Accuracy:** recognition accuracy depends on the reader and has not been measured on real screenshots.
