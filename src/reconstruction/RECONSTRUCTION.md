# Hand tracking across frames

**Track hand** turns several screenshots or video frames of one simulated or finished hand into a tracked timeline. Each frame is one observed moment. The app does three things with them:
- it works out which seat is which player in every frame;
- it compares neighbouring frames and says whether they can belong to one hand;
- it lists what changed.

It never invents actions between frames: an action becomes an event only when you enter it and the hand engine accepts it. This is an offline study tool, not live-game monitoring or play advice.

## Modules

Each concern is its own pure module with no browser APIs, so each can be tested and replaced on its own.

| Concern | File | Main API |
| --- | --- | --- |
| Recognition | `src/vision/` (providers, parsing, review), `queue.ts` (batching) | `ScreenshotProvider`, `RecognitionQueue` |
| Video input | `src/vision/video.ts` (pure), `src/web/video-frames.ts` (browser) | `videoProblem`, `sampleTimes`, `openVideo`, `captureFrame` |
| Observations | `observation.ts` | `createObservation`, `withRecognition`, `restoreObservation` |
| Player identity | `identity.ts` | `trackPlayers`, `seatPairing`, `setOverride`, `remapOverrides` |
| State comparison | `compare.ts` | `compareFrameStates(previous, current, pairing)`, `compareObservations` |
| Temporal consistency | `consistency.ts` | `classifyInterval`, `CONSISTENCY_LABELS` |
| User actions | `resolve.ts` | `checkpointState`, `checkActions` (through the hand engine) |
| Reconstruction | `reconstruct.ts` | `reconstructFrameSequence` (`reconstructHand`), `matchHistory` |
| Replay | `replay-steps.ts` | `buildReplaySteps`, `moveStep` |
| Sessions | `session.ts` | `createSession`, `parseSession`, ordering helpers |

How they connect: frames → recognition → observations → identity → comparison (through a `SeatPairing`) → consistency and reconstruction → replay steps. Comparison only compares values; it learns who is who from identity's pairing.

## Input

- **Screenshots:** up to 20 PNG, JPEG, or WebP files, each at most 12 MB and 200–16,384 px per side. Each gets a stable ID and keeps its upload position. You set the order; file names are never used.
- **Video:** one MP4, WebM, Ogg, or QuickTime file, up to 500 MB and 30 minutes, decoded by the browser's own `<video>` element.
  - **Sampling:** **Sample frames** seeks every 0.5–10 seconds and draws small thumbnails. The interval widens automatically to stay under 120 thumbnails, so the app never processes every frame.
  - **Adding frames:** ticked frames are copied at recognition size and added in video order. They are marked as video frames with their real position (`timestampMs`); no other timestamps are created.
  - **Privacy:** the video itself is not uploaded or stored.
- **Reading:** **Read frames** queues unread frames, two requests at a time. A frame that was read is cached and never sent again, a failed one has **Retry**, and a reply that arrives after its frame was removed or the batch was cancelled is dropped. Thumbnails load lazily, and temporary object URLs are released when frames, videos, or the page go away.

## Player identity

`trackPlayers(observations, { overrides, hidden })` goes through the frames in order. For each seat, it uses the first rule that applies:

1. **Your match:** a match you made: a player from an earlier frame, or `new` for someone not seen before.
2. **Name:** a name already linked to a player. A name seen for the first time waits for step 4, since it may belong to a player matched earlier by position.
3. **Your seat:** your own seat, from the previous frame where it was known.
4. **Seat position:** the seat's position relative to players already matched in this frame. This applies only when the table has the same number of seats and every matched player moved by the same amount, and a seat is never placed on a player known by a different name.
5. **Everything else:**
   - In the first frame, or when no known player is free, the seat is a new player.
   - Otherwise the seat stays **unmatched**, with candidates ranked by stack plausibility (a stack only grows when a pot is awarded). The app never merges two players on weak evidence.

**Missing players:** players seen earlier but not placed in a frame are listed as missing. That is not a fold. **Mark as not visible** records that they are still in the hand.

**Conflicts:** two seats matched to the same player are reported as a conflict.

**Stable IDs:** player IDs come from names (`name:riley`) or first appearance, so they stay the same for a given set of frames and matches.

**Seat moves:** reordering seats in the correction form keeps your matches and entered actions on the same players.

## State differences

`compareFrameStates(previous, current, pairing)` reports differences in a fixed order. Each one carries:
- the field and the tracked player ID;
- both known values and both observation IDs;
- the evidence: observed, inferred, or confirmed;
- the reader's confidence labels;
- a severity: info, review, or contradiction;
- a warning, where there is one.

**Board:**
- a new flop, turn, or river;
- several streets dealt at once (flagged);
- cards becoming readable or unreadable;
- a changed card or a shrinking board (both contradictions).

**Players:**
- stack and bet changes, and a stack that grows (flagged for review);
- folds, and all-in when a stack becomes 0;
- hole cards shown, changed (a contradiction), or hidden;
- a player unfolding (a contradiction);
- presence: hidden, visible again, appearing for the first time (flagged for review), or unmatched.

**Table:**
- pot changes, compared using everything in the middle;
- the street changing, or going backwards (a contradiction);
- the dealer button moving to another player (a contradiction that suggests a new hand);
- the blinds changing.

**Unknown values:** a value missing on either side is never a change. Unknown is never treated as zero: a stack becoming unreadable is "not readable", not all-in.

## Temporal consistency

`classifyInterval` puts each pair of neighbouring frames in one class:

| Class | Meaning |
| --- | --- |
| Consistent | Every visible change is known and explained. |
| Consistent, with missing information | Nothing contradicts, but values or players were not visible. A hidden card, a hidden player, or unknown chips never contradicts. |
| Ambiguous | Several histories fit: chips moved without known actions, streets were skipped, or a seat is unmatched. |
| Contradictory | Something that cannot happen in one hand: a changed card, a shrinking board, an earlier street, unfolding, a moved button, changed blinds, a card in two places, or chips created or destroyed. A shrinking board or an earlier street also suggests the frames are out of order. |
| Separate hands | You split the sequence here. |

Chip conservation is checked only when the same players are visible in both frames, because a hidden player's chips are unknown. A sequence is never rejected because frames in between are missing.

## Reconstruction and evidence

`reconstructFrameSequence(observations, { resolutions, identity })` returns:
- checkpoints, one per frame;
- intervals, one per pair of neighbouring frames, each with its differences, status, consistency, and reasons;
- player identities, and hands split where you marked them;
- contradictions that span the whole sequence;
- warnings and metrics.

It uses three evidence levels:
- **Observed:** read from a frame, such as "Turn dealt: Kh" or "Riley’s stack fell from 990 to 970". Two facts also follow directly from what was read: unchanged stacks while the board advanced mean only checks happened, and a run-out with at most one player holding chips means no betting.
- **Inferred:** possible explanations, such as who may have put chips in, a skipped street's betting, or a possible pot award. These are listed as alternatives and never turned into events.
- **Confirmed:** observed changes you verified with **Confirm**, values you corrected, and actions you entered.

**Entered actions** go through `checkActions`:
1. The earlier frame becomes a betting state, which needs every live seat's stack and bet. What a frame cannot show is set to the most permissive legal value: nobody has acted on the street, and the last raise was one big blind.
2. Each action is applied by the hand engine's `applyHandEvent`, which enforces amounts to call, stacks, minimum bets and raises, and folded or all-in players. Turn order is not checked.
3. If your actions close the betting round, the next street's cards are dealt from the later frame.
4. The result is compared with the later frame player by player.

Valid actions become `HandEvent`s whose timestamps record when you entered them.

## Replay

`buildReplaySteps(result)` produces one list with four kinds of step:
- **Observed frame:** the recognized table.
- **Verified event:** the hand engine's state after an action you entered and it accepted.
- **Unresolved interval:** a gap whose actions are unknown or contradictory.
- **New hand:** where you split the sequence.

First, previous, next, last, and the slider move between steps (`moveStep`, which uses the hand replay's `moveCursor`). Incomplete sequences replay as checkpoints, and nothing is invented or animated between them. **Check against saved hands** finds a recorded hand that fits every frame in order, and opens it in Hand replay.

## Manual resolution

- **Players:** match a seat to a tracked player or to someone new, go back to the automatic match, or mark a missing player as not visible.
- **Values:** correct any field with the shared correction form, including seat order. Only that frame changes, and everything is recomputed from stored observations, with no new recognition.
- **Changes:** **Confirm** marks an observed change as verified.
- **Gaps:** enter known actions, **Leave unresolved**, or **Split: these are separate hands**. **Revalidate** reruns all checks.

Corrections to identity or values recompute every comparison without touching unrelated corrections.

## Sessions

**Save session** stores a version 2 `ReconstructionSession` in `localStorage` (`poker-study:reconstructions`):
- ID, title, and times;
- source type: screenshots, video, or mixed;
- frame order and sources, with video positions;
- observations, including corrections;
- player matches and hidden-player marks;
- confirmed changes and actions;
- warnings and per-interval validation results.

Images are saved only when you tick the box. Without them, reopening restores everything but the pictures. Videos are never saved. JSON export and import use the same format. `parseSession` validates every part, upgrades version 1 files, and recomputes the derived results.

## Demo sequence

**Load demo sequence** (`DEMO_SEQUENCE` in `fixtures.ts`) has five frames of a fictional three-player hand, preflop to showdown. Every frame shows the dealer, chip stacks, the pot, and the hole cards that are known. It shows:
- an unreadable name, so Riley is matched by seat position;
- a client that hides folded players, so Sam is not visible in frame 4 (not a fold);
- a misread turn card (Kh read as Kd) to correct;
- the flop actions between frames 2 and 3, supplied as confirmed, which replay as verified events;
- unresolved gaps elsewhere.

It needs no API key.

## Toward physical tables

Any provider that returns a `ScreenshotRecognition`, such as a camera or an on-device model, feeds the same queue, identity, comparison, consistency, and reconstruction modules without changes to the hand history engine.

## Limitations

- **Turn indicators:** the reader does not report which player is to act, so changes in the active player are not tracked.
- **Turn order and raise size:** turn order is not checked for entered actions, and the minimum raise assumes the last raise was one big blind.
- **Pot detail:** side pots shown separately on screen are read as one pot, and rake is not modeled.
- **Unnamed seats:** identity relies on names, your seat, and relative position. Players with no readable name at a table whose size changed stay unmatched until you match them.
- **Video:** decoding depends on the browser's codecs, and frame times come from seeking, so they are as precise as the browser's seek. Video extraction was not exercised in an automated browser test; the sampling and validation logic is unit-tested.
- **Accuracy:** recognition accuracy has not been measured on real screenshots or video.
- **Saved hands:** a fully resolved session cannot yet be saved as a hand history.
