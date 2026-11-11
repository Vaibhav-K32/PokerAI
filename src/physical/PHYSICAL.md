# Physical table photos

**Scan table** reads a still photo of real cards and chips from a simulated game, a teaching demonstration, or a finished hand. It reads the photo, works out the table layout, and lets you correct everything. The result becomes the same table state that screenshots produce, so the study table, the Step 3 checks, Track hand, and replay all work unchanged.

This is offline study only: there is no recording, no continuous capture, no live-game monitoring, and no play advice.

## Pipeline and modules

```
Photo (upload, drag and drop, demo, or camera still)
→ image checks and resize (src/web/image.ts)
→ photo quality (quality.ts)
→ reading (Claude, layout=physical; or a stored sample)
→ validation (parse.ts)
→ table geometry (geometry.ts)
→ chip values (chips.ts)
→ review and corrections (edits.ts, src/web/physical-view.ts)
→ the shared table state (convert.ts → ScreenshotRecognition)
→ study table, or Track hand (Step 4)
```

| Concern | Module |
| --- | --- |
| Image preprocessing | `src/web/image.ts`, the same as screenshots: type and size checks, orientation, resize to 1,568 px, re-encode |
| Photo quality | `quality.ts`: `photoChecks` (pixels) and `framingChecks` (card boxes) |
| Card recognition | Claude through `scripts/recognize.mjs` (`PHYSICAL_SCHEMA`); `parse.ts` validates the result |
| Table geometry and seat mapping | `geometry.ts`: `interpretTable`, `zoneAt`, `clockwiseOrder`, `boardOrder` |
| Chip recognition and values | `chips.ts`: `ChipConfiguration`, `groupValue`, `sumGroups` |
| Corrections | `edits.ts` |
| State conversion and validation | `convert.ts`: `physicalToRecognition`, `physicalIssues`; then the existing `reviewScreenshot`, `toStudySnapshot`, and `holdem.validate` |
| Providers | `src/vision/providers.ts`: `claudePhysicalProvider`, `fixturePhysicalProvider`, `physicalAsScreenshotProvider` |
| Camera | `src/web/camera.ts` (`CameraController`) |
| Interface | `src/web/physical-view.ts` |
| Demo data | `fixtures.ts`: `PHYSICAL_FIXTURES`, `PHYSICAL_SEQUENCE`, `DEMO_CHIPS` |

## Photos and the camera

- **Upload:** JPEG, PNG, or WebP up to 12 MB, by file picker or drag and drop. You can remove or replace the photo; a new photo never changes the current review until it is read.
- **Camera:** **Use the camera** asks for permission only when pressed. It prefers the rear camera (`facingMode: environment`), shows a live preview, and takes one still with **Capture**.
  - **Release:** the camera stops right after capture, on **Close camera**, when you leave the tab, and when the page is hidden. A start that finishes after you closed the camera is stopped at once.
  - **Retake and switch:** **Retake photo** starts it again, and **Switch camera** cycles through cameras when there is more than one.
  - **Failures:** denied permission, no camera, a camera in use, an insecure page (not HTTPS or localhost), and unsupported browsers each give a message and fall back to upload.
- **Photo quality:** each note reports its measurement, and you can always continue:
  - **Darkness:** average brightness under 20%.
  - **Glare:** more than 6% near-white pixels.
  - **Low resolution:** shortest side under 900 px.
  - **Blur:** variance of the Laplacian under 30, judged only when the photo has enough contrast.
  - **Cut-off cards:** after reading, card boxes touching the image edge.
  - **Distance:** cards, chips, and seats spread over less than 35% of the photo in both directions.

## Reading a photo

The `physical` layout asks Claude for:
- **Seats:** listed clockwise from the seat nearest the camera, with whether the space in front of each seat is clearly empty.
- **Cards:** each card's code, or face down, or unknown with its rank or suit if only one is legible. Also its visibility (face up, face down, partly hidden, unknown), a rough box, rotation, and zone (board, a seat, or unknown).
- **Dealer button:** where it is and which seat it belongs to.
- **Chips:** each pile's colour, its count as counted, estimated, or unknown, its position, and its zone (stack, bet, or pot).
- **Middle:** whether the middle is clearly empty.

Coordinates are fractions of the image, so outlines stay aligned at any zoom. They are approximate and are drawn only when reported; cards you add have no outline. Confidence is the reader's label (high, medium, low), never a percentage, and `null` when not given. Malformed or impossible readings are rejected.

## Table geometry

`interpretTable` checks the reader's grouping against the positions:
- **Board:** a card much closer to the table centre than to any seat is on the board.
- **Seats:** otherwise it belongs to the nearest seat, but only when that seat is clearly nearer (by 25%) than the next. Near-ties stay unassigned with a reason.
- **Disagreements:** when the reader's zone and the positions disagree, the card is left unassigned with both explanations, for you to decide.
- **Your placements:** these are never changed afterwards.
- **Board order:** board cards are ordered along their own axis, so an angled or rotated board still reads in order.
- **Seat order:** seats are ordered clockwise from your seat, or from the seat nearest the camera, so the camera can be anywhere. Once you reorder seats, your order is kept.
- **Chips:** unassigned chips go to the nearest seat, as stack or bet by how far toward the centre they sit, or to the pot.
- **Dealer:** the button goes to the nearest seat when the reader did not say.

You can mark the table centre and each seat's position on the photo. Anything you have not placed yourself is then regrouped.

## Chips

Chip colours have no standard value, so you set what each colour is worth in your game (**Chip values for this game**). The values are saved in this browser and also used by Track hand; nothing is assumed, and the list starts empty. The demos bring their own values (red 5, green 25, black 100).
- **Confirmed or estimated:** a pile's value is its count × its colour's value. It is confirmed only when counted clearly or set by you; estimated counts are flagged.
- **Unknown:** unknown counts or colours with no value make the amount unknown, never zero.
- **Stacks, bets, and the pot:** a stack, bet, or pot is the sum of its piles. A bet or pot is 0 only when the reader saw that area clearly empty (recorded as observed, medium confidence), or when you set it.
- **Typed amounts:** an amount you type overrides the chips, and **Use chips** goes back.
- **No bets:** **No bets in front of anyone** sets every unknown bet to 0 in one step.

## Corrections

Everything can be corrected, and every change is rechecked:
- **Cards:** card values with the shared card picker, including **Mark as unknown**. Visibility (face up, face down, partly hidden). Adding missing cards, removing false detections, and moving cards between the board, seats, and unassigned.
- **Seats:** names, status, your seat, the dealer, seat order (move up or down), adding and removing seats, and placing seats on the photo.
- **Chips and table:** chip counts, how certain each count is, colours, colour values, and which seat, bet, or pot a pile belongs to. Also the street, the pot, and the blinds.

**Blocking problems:**
- one card detected twice, anywhere;
- more than five board cards;
- more than two cards at a seat;
- fewer than two seats;
- cards at a removed seat;
- any Step 3 error in the converted state.

**Flagged for review:** unassigned cards and chips, partly read or hidden cards, estimated or uncounted piles, and colours with no value.

## Conversion and import

`physicalToRecognition` builds a `ScreenshotRecognition`:
- seats in clockwise order, with their names, statuses, and hole cards (face-down cards as hidden, unread ones as unknown);
- stacks and bets from chips or your typed amounts, with chip certainty as the confidence label;
- the board in order, and the pot from written text, pot chips, or a clearly empty middle;
- the dealer, your seat, the street (inferred from the board when not stated), and the blinds;
- the reader's notes.

Nothing missing is filled in. **Load into study table** goes through the existing `toStudySnapshot` and `holdem.validate`, and lists exactly what is still needed. **Add to Track hand** adds the reviewed photo as a recognized frame, so it is not read again.

## Several photos: Track hand

In Track hand, choose **Images are: Photos of a physical table** and add photos in any order. Each is read with the `physical` layout and your chip values, then tracked with the Step 4 modules: player identity, comparison, consistency, reconstruction, replay, and sessions. Photo frames are saved with source `physical_photo`, and the session's source type is `photos`. The sample **Physical table photos, preflop to turn** shows three photos of one hand with no API key.

## Demo

**Load physical table demo** draws one of six staged tables (SVG made for this project, rendered as a 1800×1200 photo) and reads it from stored results. A banner says these are sample data, not AI recognition. The tables are:
1. **Two players, clear cards**
2. **Four players with community cards:** the turn, with one player folded
3. **Rotated, angled photo:** 24° rotation and perspective
4. **Partly hidden cards:** a hand covers a board card and one of your cards
5. **Chip stacks and bets:** one pile estimated, one uncounted
6. **Uncertain card reading:** a blurred 9♠ read as a 6♠ with low confidence

## Limitations

- **Overlap, lighting, and decks:** readings may be wrong when cards overlap, chips are hidden or stacked unevenly, lighting is poor or uneven, there is glare, or the deck design is unusual. Similar ranks (6/9, 8/3, J/Q) are easy to confuse when blurred.
- **Positions:** they are the reader's approximations, not detected outlines. Grouping by position can be wrong at crowded tables, which is why near-ties are left to you.
- **Chip counts:** they come from the reader's view of the stack, and tall or leaning stacks are often only estimates. Values need your chip configuration.
- **Seats and players:** seats are identified by cards and chips near them; the reader does not recognise people. Names come only from visible labels.
- **Accuracy:** it has not been measured on real photographs; that needs a labeled set of consented photos.
- **Camera:** camera capture was tested with simulated devices, not a real camera.
- **Not included:** perspective correction of the image itself (rotation is a display aid) and on-device recognition.

## Future improvements

- Measure accuracy on a labeled photo set.
- Add an on-device card detector behind the same provider interface.
- Allow optional perspective correction from four marked table corners.
- Use per-pile chip height estimation when a reference chip is known.
- Save a fully specified tracked hand as a hand history.
