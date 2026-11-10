# Hand history and replay engine

`src/history/` reconstructs a no-limit Texas Hold’em hand for 2–10 players from a fixed setup and an ordered list of events. It is pure TypeScript with no browser or UI imports. The study table, a future screenshot reader, and a future camera pipeline all share the same rules. Tests import the compiled modules from `dist/history/`.

| Module | Purpose |
| --- | --- |
| `types.ts` | Event, setup, state, and error types; `HAND_SCHEMA_VERSION` |
| `engine.ts` | `createHandState`, `applyHandEvent`, `replayHand`, `replaySteps`, pots, settlement helpers, `actionOptions` |
| `history.ts` | Stored history format, `createHistory`, `serializeHistory`, `parseHistory`, migrations, `eventFactory`, `settlementSpecs` |
| `describe.ts` | Timeline text for each event |
| `cursor.ts` | Replay navigation and playback timing |
| `snapshot.ts` | `toAnalysisSnapshot`: a replayed decision as an analyzer snapshot |
| `observation.ts` | `validateCandidate` and `expectedNext` for recognition modules |
| `demo.ts` | The demo hand and test fixtures |

## Events

Every event has `schemaVersion` (1), a unique `id`, a `type`, an ISO 8601 `timestamp`, the `handId`, and a `payload`.

| Type | Payload |
| --- | --- |
| `HAND_STARTED` | `{}` |
| `ANTE_POSTED`, `SMALL_BLIND_POSTED`, `BIG_BLIND_POSTED` | `{ playerId, amount }`. Each forced post is the full amount or the player's whole stack. |
| `PLAYER_FOLDED`, `PLAYER_CHECKED` | `{ playerId }` |
| `PLAYER_CALLED` | `{ playerId, amount }`. `amount` is the chips added (all-in when short). |
| `PLAYER_BET`, `PLAYER_RAISED` | `{ playerId, to }`. `to` is the total street commitment. |
| `PLAYER_ALL_IN` | `{ playerId, amount }`. `amount` is the whole remaining stack. The engine classifies it as a call, bet, or raise. |
| `FLOP_DEALT` | `{ cards: [3 cards] }` |
| `TURN_DEALT`, `RIVER_DEALT` | `{ card }` |
| `SHOWDOWN_STARTED` | `{}` |
| `PLAYER_CARDS_REVEALED` | `{ playerId, cards: [2 cards] }` |
| `POT_AWARDED` | `{ potIndex, awards: [{ playerId, amount }] }`. Pot 0 is the main pot. |
| `HAND_COMPLETED` | `{}` |
| `HAND_CANCELLED` | `{ reason }`. Every chip goes back to its owner. |

Cards use rank plus suit, such as `As`, `Td`, or `7h`. Unknown hole cards are `null` and are never guessed.

## Reducer API

```ts
const initial = createHandState(setup);           // validates the setup
const next = applyHandEvent(state, event);         // one event; throws HandRuleError
const final = replayHand(initial, events);         // whole list; errors name the event
const states = replaySteps(initial, events);       // states[i] follows i events
```

`applyHandEvent` never mutates its input. It checks the event envelope (schema version, unknown types, duplicate IDs, hand ID, timestamp) and then the rules. An illegal event throws `HandRuleError` with a readable message and leaves the input state untouched. `actionOptions(state)` lists the actor's legal choices, and `nextPost(state)` names the next forced post.

## State and transitions

`GameState.step` says what the engine expects next:

```
start ─HAND_STARTED→ post ─antes, SB, BB→ act ⇄ (betting)
act ─round closes→ deal ─FLOP/TURN/RIVER→ act …   (streets with fewer than two players able to bet are skipped)
river closes → showdown ─SHOWDOWN_STARTED→ reveal ─reveals, POT_AWARDED…→ done ─HAND_COMPLETED→ complete
everyone else folds → award ─POT_AWARDED→ done
any time before an award ─HAND_CANCELLED→ cancelled
```

Each player tracks `stack`, the street commitment (`committed`), the hand total (`total`, antes included), `status` (`active`, `folded`, `all-in`), cards, whether they have acted, and chips `won`. `potTotal(state)` and `chipsInPlay(state)` expose the pot and the conserved chip total.

### Rules applied

- **Positions:** seats are clockwise. Heads-up, the dealer posts the small blind, acts first preflop, and acts last after the flop. With three or more players, the blinds follow the dealer. Preflop starts left of the big blind; later streets start with the first live player left of the dealer.
- **Forced posts:** antes go around from the seat left of the dealer, then the small blind, then the big blind. A short stack posts what it has and is all-in. The big blind sets the preflop price even when posted short.
- **Betting:** a minimum bet is one big blind. A minimum raise adds the last full bet or raise. Smaller amounts are allowed only all-in. A short all-in raise does not reopen betting for players who already acted. They may raise again only once the price has risen by a full raise since they acted, which also covers several short all-ins that add up to one. Nobody may bet or raise when no one is left to respond.
- **Round end:** betting closes when every player with chips has acted and matched the bet, including the big blind's preflop option. The uncalled part of the top bet goes back to its owner. When fewer than two players can still bet, the remaining streets are dealt without action.
- **Pots:** main and side pots are built from each player's hand total. Folded chips stay in the pots they reached.
- **Awards:** a pot must go to the right players when they can be determined: a single eligible player, or all eligible hands known on a full board. Splits are even, with odd chips one at a time to winners starting left of the dealer. When some eligible hands are unknown (mucked), declared winners are accepted if they are eligible and the split follows the same rule.
- **Cards:** no card can appear twice across the board and every known or revealed hand. Reveals must match known cards.
- **Conservation:** stacks plus the unawarded pot always equal the starting total. The tests check this after every event.

## Stored histories

A `HandHistory` is `{ kind: 'poker-study/hand-history', schemaVersion, id, name, createdAt, playerCount, setup, events, result, finalState }`. `setup` holds the dealer seat, blinds, ante, and players with starting stacks and known cards. `result` holds the status, board, pots with awards, net chips per player, and winners.

`serializeHistory` writes pretty JSON. `parseHistory` accepts text or a parsed value. It checks the kind, migrates older schema versions (`MIGRATIONS` in `history.ts`; version 1 is the first), and rejects newer ones. It then replays every event and rejects the file if the stored `finalState` or `result` differs from the replay. A file without those fields imports by replaying.

The web app keeps saved hands in `localStorage` under `poker-study:hand-histories` (`src/web/hand-store.ts`). Each saved hand is validated again on load, and unreadable entries are reported and skipped.

## Replay in the app

Open **Hand replay** from the view switcher, then select **Load demo hand** or import a JSON file. The table shows the board, the cards known at each step, stacks, street bets, the pot, the dealer and blinds, folded, all-in, and to-act markers, and the phase. The controls are first, previous, play/pause with speed, next, last, and a timeline slider. Clicking an event in the timeline jumps to it. Playback stops on pause, when another hand opens, when you leave the view, or when the page is hidden. The opened hand is frozen and never changed. **Analyze this decision** appears when the player to act has known cards and two to four players are in the hand. It puts that decision on the study table through `toAnalysisSnapshot`.

## Connecting recognition later

A recognizer should emit candidate events, never new state:

```ts
const result = validateCandidate(state, { event, source: 'screenshot', confidence: 0.92 });
if (result.ok) { /* show the change for confirmation, then append the event */ }
else { /* report result.error and keep the old state */ }
```

`expectedNext(state)` lists the event types the engine will accept and which player is expected. A reader can use it to decide what to look for. Recognition is not implemented here, and nothing infers events automatically. Every candidate should still be confirmed by the user before it joins a history.

## Known limitations

- Dead blinds, missed blinds, straddles, bring-ins, rake, and tournament rules are not modeled. Every seated player must start with chips.
- An all-in opening bet smaller than the big blind leaves the minimum raise at that bet plus one big blind.
- Folding is allowed even when checking is free, matching common rules.
- Showdown order and mucking are not enforced; players may reveal in any order.
- Odd chips go left of the dealer for every pot. House rules that differ are not modeled.
- The older heads-up reducer in `src/rules/holdem-replay.ts` remains for compatibility. New work should use this engine.
- Hand recording in the app is import-only. There is no form yet for entering a new hand event by event.
