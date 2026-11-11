# Recognition benchmarks

This system measures how well recognition matches labeled ground truth: screenshots, physical photos, and hand sequences. It is an evaluation tool. Its numbers describe one dataset, and they are not a guarantee of accuracy on other images.

**Tests versus benchmarks.**
- `npm test` checks that the metric code computes the right numbers from fixed inputs. Those checks are deterministic and never call an API.
- A **benchmark** measures a recognizer against labeled images. Only a real run on real, labeled images measures real accuracy.
- The built-in dataset uses drawings made for this project, so its scores (for example 97.2% exact cards on the mock run) say nothing about real screenshots or photos.

## Modules (`src/benchmark/`)

| File | Role |
| --- | --- |
| `types.ts` | Dataset, ground truth, predictions, per-sample results |
| `dataset.ts` | `parseDataset`, `parseSample`, `parseGroundTruth`, `groundTruthProblems`: runtime validation |
| `builtin.ts` | The built-in synthetic dataset (`synthetic-1`), with truth taken from the drawing definitions |
| `metrics.ts` | `scoreSample`, `cardOutcome`, `matchSeats`, `iou`, `matchBoxes` |
| `tracking.ts` | `scoreSequence`: Step 4 tracking against sequence truth |
| `runner.ts` | `runBenchmark`, `mockPredictor`, `selectSamples` |
| `report.ts` | `summarize`, `compareRuns`, `runToJson`, `runToCsv`, `parseRun` |

The command-line tool is `scripts/benchmark.mjs`. The dashboard is **Benchmarks** (`src/web/benchmark-view.ts`).

## Datasets

A dataset is a JSON manifest (`kind: "poker-study/benchmark-dataset"`, `schemaVersion: 1`) with a name, a `datasetVersion`, samples, and optional sequences. The built-in one is committed as `benchmarks/datasets/synthetic-1.json`, and a test keeps it in sync with the fixtures. No database is used.

Each sample has:
- an `id` and a `sourceType` (`digital_screenshot` or `physical_photo`);
- an image: `{ kind: "file", path }`, relative to the manifest, PNG, JPEG, or WebP; or `{ kind: "synthetic", fixture }` for built-in drawings;
- `groundTruth`, difficulty `tags`, free-text `metadata`, an `annotationStatus` (`draft` or `verified`), optional `chipConfig` for photos, and `notes`.

Ground truth records what a careful person can see:
- **Seats:** listed clockwise from the bottom of the image. Each has a name (or `null`), two card slots or none, a stack, a bet (`null` when not visible, 0 when visibly none), and folded status (`true`, `false`, or `null`).
- **Cards:** each slot is a card, `face_down`, or `unreadable` (a visible face that cannot be read). Photo cards may carry a measured `box` (fractions of the image) and `tags` (`rotated`, `occluded`, `blurred`).
- **Table:** the board (0, 3, 4, or 5 slots), the pot as shown (`null` when not visible), the dealer and your seat (`null` when not shown), the street, and the blinds.

**Validation rejects:**
- invalid card codes, and duplicate cards (unless `allowMalformed` is set for malformed-input tests);
- a 1- or 2-card board, or a street that contradicts the board;
- seat indexes out of range, and impossible blinds;
- negative or fractional chips;
- absolute or `..` image paths;
- unknown tags, and duplicate sample IDs;
- sequences that refer to missing samples.

Images are never committed. Use only images you made or have the right to use.

## Annotating

In **Benchmarks → Annotate ground truth**:
1. Choose an image.
2. Enter the seats (name, stack, bet, folded), cards (pick each with the card picker, or mark it face down or unreadable), the board, pot, blinds, street, your seat, the dealer, difficulty tags, and notes.
3. **Validate** checks everything, including that no card slot is left blank.
4. **Save** keeps the annotation in this browser and never overwrites an existing ID without asking.
5. **Export** writes a validated dataset JSON; put the image files next to it.

Annotations are entered by a person, not taken from recognizer output, and stay `draft` until you tick that you checked every field yourself.

## Running

- **Mock run, no API calls:** `npm run benchmark` runs the built-in dataset with the stored fixture readings. These include deliberate mistakes:
  - a 7♣ read as 7♠;
  - K♥ read as K♦;
  - a blurred 9♠ read as 6♠;
  - covered cards;
  - an unreadable stack.

  Add `--out benchmarks/runs` to save the run as JSON and CSV (that folder is git-ignored). The dashboard's **Mock** mode does the same in the browser.
- **Real run, paid:**
  - **Browser:** **Benchmarks → Recognizer: Real**. It works for synthetic drawings and imported image files, through the app server (`npm start` with `ANTHROPIC_API_KEY`).
  - **Command line:** `npm run benchmark -- --dataset path/to/dataset.json --real` for file images.

  Both show how many images will be sent and ask first; `--yes` skips the prompt. The key stays on the server (or in the command's environment), and nothing runs automatically in tests or builds.
- **Options:**
  - `--limit N`, or the dashboard's sample limit.
  - Sources: screenshots and/or photos.
  - Two requests at a time (`--concurrency`, at most 4).
  - `--keep-raw` keeps raw readings for debugging.
- **Cancelling:** **Cancel** in the dashboard or Ctrl+C on the command line. Finished samples are scored, and the rest are marked cancelled.
- **No repeated requests:** each image is recognized once per run, even if several samples use it.
- **Recorded per run:** run ID, times, git commit (command line), dataset version, provider and model IDs, configuration, metrics, and latency. It also counts requests, successes, failures, timeouts, and retries. Cost is reported as unavailable because the API response does not include billing.
- **Saved runs:** dashboard runs are saved in the browser (the last 10), and raw readings only when kept.

## Card metrics

Every card position is compared with the truth at the same place.
- **Board:** cards are compared by index.
- **Hole cards:** seats are paired by visible name first, then by position where names do not conflict. Finding the same card elsewhere in the image does not count.

| Outcome | Meaning |
| --- | --- |
| exact | Right rank and suit |
| rank_only / suit_only | Right rank, wrong suit / wrong rank, right suit |
| wrong | Both wrong |
| missing | A readable card was given no value |
| extra | A value where the truth has no card or a card back |
| invented | A value for a card no one can read |
| correct_unknown / correct_hidden | Unreadable or face-down cards correctly given no value |

- **Over positions with a readable card:** exact = exact/known, rank = (exact + rank_only)/known, suit = (exact + suit_only)/known, missing = missing/known.
- **False positives:** (extra + invented) over all values given.
- **Unknown handling:** correct_unknown / (correct_unknown + invented).

Every metric is shown with its numerator and denominator, and as n/a when the denominator is 0. These are split by source (screenshot or photo) and by area (community or player cards).

## Table and chip metrics

- **Players and seats:** player count correct per sample; seat assignment (true seats found at the same position); missing and extra players.
- **Roles:** dealer and your seat (correct when the predicted seat is the same player); street; folded status.
- **Invalid states:** predictions that break the app's own checks.
- **Pot, stacks, and bets:** exact-match rate and mean absolute error over values known on both sides, plus missing (truth known, prediction unknown), invented (truth not visible, value predicted), and correctly unknown. There are no percentage errors, so a true 0 is handled by absolute error.

## Physical detection

When the truth has card boxes and the reading has positions, predicted boxes are matched one-to-one to true boxes. Matching is greedy by intersection over union, at IoU ≥ 0.5. Reported:
- recall, precision, and mean IoU of matches;
- grouping: matched cards placed on the board or the right seat;
- exact-card accuracy for rotated, occluded, and blurred cards.

A reading without positions is counted as **localization unsupported**; nothing is invented. On the mock run, boxes match exactly because the stored readings were drawn from the same geometry. Real readings give approximate boxes.

## Tracking metrics

Each sequence's predicted frames run through the Step 4 engine and are compared with the true frames:
- **Identity consistency:** each named player keeps one tracked ID across frames, and no one else shares it.
- **Card reveals:** reveals found (recall) and reported in error.
- **Street transitions:** the board-count change is right.
- **Out-of-order warnings:** warnings on a correctly ordered sequence (false).
- **Contradictions:**
  - **False:** flagged when both frames were read without errors.
  - **Justified:** caused by a reading error.
  - **Missed and caught:** frames marked `sameHand: false` that the engine did or did not flag.
- **Unresolved gaps:** precision and recall against gaps where chips truly moved. Since no betting actions are entered, these gaps should stay open; invented actions are never scored as correct.
- **Checkpoints:** frames whose board and stacks match the truth.

## Confidence

The recognizers give labels (high, medium, low, or none), not numbers. So reliability curves and expected calibration error are reported as unavailable. The report gives:
- exact-card accuracy within each label;
- the high-confidence error rate;
- the low-confidence correct rate.

The labels are the model's; the rates are measured on the dataset.

## Difficulty

Samples can have several tags:
- lighting: clean, bright, dim, glare;
- view: rotated, angled, overlap, occlusion, blur;
- image: low resolution, unusual layout, unreadable text.

Each tag shows its sample count and exact-card accuracy. Tags with fewer than 5 samples are marked as too few to compare.

## Comparing runs

**Compare** in the dashboard, or `npm run benchmark -- --compare old.json new.json`, lists each headline metric as improved, regressed, unchanged, or n/a. It knows which direction is better: fewer missing cards and a smaller error count as improvements.

Runs are directly comparable only with the same dataset and version, the same metric definitions (`METRICS_VERSION`), the same sample selection, and both complete. Anything else is flagged as not equivalent. Different providers or models are noted, since comparing them is often the point.

## Export

- **JSON:** the full run, with the dataset and run metadata, metrics, per-sample results, error categories, latency, and warnings.
- **CSV:** one table with a `section` column (run, metric, latency, sample, error, warning). Cells are quoted as needed, and leading `= + - @` characters are neutralised.

Neither includes images or keys. Raw readings are included only with **Keep raw readings**.

## Limitations

- **Dataset:** the built-in dataset is synthetic and small (34 samples, 7 sequences). Every difficulty tag has fewer than 5 samples except clean.
- **Real runs:**
  - **Command line:** it cannot render the synthetic drawings, so use the browser for those. It does not resize images over 5 MB.
  - **Browser:** a real run needs the app server and a key, and has not been executed in this repository.
- **Calibration:** numeric calibration is unavailable until a recognizer reports numeric confidence.
- **Seat pairing:** pairing by name and position can misattribute cards when names are unreadable and seats are reordered.

## Recommended next steps

- Collect and annotate consented real screenshots and photos, at least 30 per difficulty tag.
- Run the real recognizer on them, then compare runs after each prompt or model change.
- Target the largest error categories first.
