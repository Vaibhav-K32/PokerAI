# Screenshot recognition

Import screenshot reads a screenshot of a digital Texas Hold’em table from a simulated or finished hand. You review and correct every field, then use the result in the study table or attach it to a saved hand. It is an offline study tool. It does not monitor live games, advise during play, or act on any poker client.

## Pipeline

```
Upload (file picker, drag and drop, or a built-in sample)
→ Image checks: PNG, JPEG, or WebP; ≤ 12 MB; 200–16,384 px per side; orientation applied (src/web/image.ts)
→ Resize to 1,568 px on the long edge and re-encode as JPEG, which drops metadata
→ Provider (src/vision/providers.ts): Claude through POST /api/recognize?layout=screenshot, or a fixture
→ Structured extraction: the server asks Claude for JSON matching SCREENSHOT_SCHEMA (scripts/recognize.mjs)
→ Schema validation: parseScreenshotResponse rejects malformed or impossible output (src/vision/screenshot.ts)
→ Game-state checks: reviewScreenshot lists blocking errors and fields to review
→ User review and correction (src/web/screenshot-view.ts, shared card picker)
→ Load into the study table (toStudySnapshot → holdem.validate), save, or attach to a saved hand
```

The server reuses the photo-recognition endpoint, API key handling, same-origin check, size limits, and error mapping. It adds a `layout=screenshot` prompt and schema and a 90-second request timeout. The existing card-photo layout and its response are unchanged.

## What is read

| Area | Fields |
| --- | --- |
| Seats, clockwise from the bottom center | name, chip stack, bet in front, folded or in the hand, hole cards (face-up, unreadable, face-down, or none) |
| Table | community cards, pot, small and big blind, dealer seat, your seat, street (only when written on screen) |
| Notes | the reader’s plain-language warnings about cropping, overlap, or unreadable text |

Every value is a `RecognizedField`: the value or `null` for unknown, the reader’s own label (`high`, `medium`, `low`, or `null` when none is usable), and its source (`observed`, `inferred`, or `corrected`). The labels are not calibrated probabilities, and the app shows none as a number. The only inferred value is the street, taken from the number of board cards when the screen does not state it. Unknown values stay unknown. The model is told never to compute or estimate a value, and the app never fills one in.

## Review and correction

Each field shows **High confidence**, **Needs review**, **Unknown**, or **Conflict**, with “inferred” or “edited” where it applies. Every field can be edited. Card slots open the same card picker as the study table, with cards in use elsewhere disabled and **Mark as unknown** to clear a card. Seats can be added or removed, and you mark your own seat and the dealer. Each change re-runs the checks.

Blocking problems prevent saving, attaching, and loading:
- **Duplicate cards.**
- **Impossible boards:** a board with 1, 2, or more than 5 cards.
- **Conflicting streets:** the street shown on screen contradicts the board.
- **Seat counts:** fewer than two seats, or fewer than two still in the hand.
- **Chip amounts:** a pot smaller than the bets it includes, or a small blind larger than the big blind.

Unreadable cards, unknown stacks or bets, low-confidence values, and an unknown dealer or seat are marked for review.

**Load into study table** also needs a complete decision:
- **Your seat:** both of your cards and your stack.
- **Players:** two to four players still in the hand, with every stack, bet, and status known.
- **Table:** the pot, every board card, and the big blind, which is used as the minimum raise increment because a screenshot does not show the last raise size.

If anything is missing, the button lists what to fill in. A screenshot pot usually excludes the bets in front of players, so the app adds them. Tick “The pot shown already includes the bets” when the client’s pot already counts them. The study table changes only when you select Load; a failed or cancelled scan leaves it untouched.

## Saving and saved hands

- **Save for later** keeps the reviewed state in this browser (`poker-study:screenshots`). The image is stored only when you tick **Also save the screenshot image**, as a resized JPEG.
- **Attach to hand** lists saved hands that agree with everything the screenshot shows. It uses `matchObservation` in `src/history/observation.ts`, which replays each hand and compares the board, pot, stacks, bets, folds, known cards, and names (when visible) at every event and seat rotation. After you confirm, the hand gains an attachment at that event. No events are added: a screenshot is one observed moment, not proof of earlier actions. Imported hand files re-check every attachment.
- **Open in hand review** opens the attached hand in the replay view at the matching event, where its attached screenshots are listed.

## Providers

`ScreenshotProvider.recognize(image, signal)` resolves to `recognized`, `failed` (with a reason and whether retrying can help), or `cancelled`. It never throws for expected failures.

| Provider | Use |
| --- | --- |
| `claudeScreenshotProvider()` | The app server and Claude. Handles a missing key (503), rate limits (429), timeouts (504 and a 100-second client limit), unsupported or oversized images, network errors, static hosts without the endpoint, and malformed output. |
| `fixtureProvider(payload)` | Deterministic results for tests and the built-in samples |
| `localScreenshotProvider` | Placeholder for a future on-device model |

To configure Claude, start the server with `ANTHROPIC_API_KEY` set (see the README). Each scan is one paid request to `claude-opus-5-5`. The samples never call the API.

## Fixtures

`src/vision/screenshot-fixtures.ts` draws six fictional tables as SVG, all made for this project. Each comes with the response a careful reader would give:
- **Heads-up preflop.**
- **Three-player flop** with a folded seat and no street label.
- **Four-player turn.**
- **River** with a full board and a shown opponent hand.
- **Partly hidden cards:** a chat box covers a board card and one of your cards.
- **Unreadable text:** blurred names, stacks, and pot.

**Try a sample** renders one to PNG and reads it through the fixture provider.

## Toward physical tables

The pipeline is provider-agnostic: anything that produces a `ScreenshotRecognition` gets the same checks, review screen, and conversions. A physical-table camera provider would implement `ScreenshotProvider` with its own layout prompt or local model, and the rest stays unchanged. The hand history engine accepts observations only through `matchObservation` and `validateCandidate`. Recognition never writes events on its own.

## Limitations

- **Accuracy:** it depends on Claude and on how clear the screenshot is. The fixtures exercise the pipeline, not real-world accuracy, which needs a labeled test set from real practice screenshots.
- **Card regions:** they are not highlighted on the image, because the reader does not return coordinates.
- **Stacks in big blinds:** a stack shown only in big blinds is read as unknown.
- **Minimum raise:** a screenshot does not show the last raise size, so analysis uses the big blind as the minimum raise.
- **Seat order:** seats must be listed clockwise from the bottom. Clients that rotate the hero to another position may need seats reordered by hand, by removing and re-adding them.
- **Study table limit:** it analyzes two to four players still in the hand. Larger screenshots can still be saved and attached to saved hands of up to 10 players.
