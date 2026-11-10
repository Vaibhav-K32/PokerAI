# Heads-up Hold’em replay

The replay reducer accepts study events for a simulation or a completed hand. Call it from TypeScript using `holdem-replay.js` from this directory. Tests import the compiled module at `dist/rules/holdem-replay.js`.

## API

- `startHoldemReplay(config)` posts the blinds and returns the opening state. Supply `purpose`, `button` (seat 0 or 1), the equal `startingStack`, `smallBlind`, and `bigBlind`. Optional `holeCards` is a pair of arrays in seat order. Each array is empty or contains two known cards.
- `applyHoldemEvent(state, event)` returns a new state. An invalid event throws an error and leaves the input state intact.
- `replayHoldem(config, events)` applies a history in order from the opening state. It throws at the first invalid event.
- `amountToCall(state)` gives the acting seat's chip cost, or `null` when there is no decision.
- `toHoldemSnapshot(state)` returns the existing analyzer's snapshot from the acting seat's perspective. That seat's hole cards must be known. Supply only opponent cards you intend to reveal to the analysis.

Every player event has a `seat`. `bet` and `raise` also have a `to` amount in total chips committed on the current street. `call` calculates the matching amount automatically. The `deal` event takes `cards` and advances a closed betting round to the flop, turn, or river. Supply only the newly dealt cards. The state exposes the current street, actor, phase, pot, both stacks and street commitments, and the minimum opening bet or last full raise increment.

```ts
const flopDecision = replayHoldem(
  {
    purpose: 'simulation', button: 0, startingStack: 100,
    smallBlind: 1, bigBlind: 2, holeCards: [[], ['Ad', 'Kd']],
  },
  [
    { kind: 'raise', seat: 0, to: 6 },
    { kind: 'call', seat: 1 },
    { kind: 'deal', cards: ['Qs', 'Js', '4d'] },
  ],
);
const result = analyze(toHoldemSnapshot(flopDecision));
```

The big blind gets an option after a preflop limp. After the flop, the player off the button acts first. The pot includes all committed chips, including the current street. See [Poker TDA rules 36 and 45](https://www.pokertda.com/view-poker-tda-rules/) for heads-up action order and full raise sizing.

## Boundaries

A fold facing a wager ends replay and records `foldWinner`. Closing river betting ends at `showdown`. Both states preserve the pot and stacks before settlement. A matched full all-in can continue through explicit board deals without further player actions.

The first pass supports exactly two seats with equal starting stacks above the big blind. Short all-ins, no-wager folds, blind all-ins, unequal stacks, antes, straddles, burn cards, uncalled-chip refunds, and payouts are deferred. The existing snapshot analyzer can still list a short all-in raise in some situations. Replay accepts only full bets and raises. Replay is a core API with manual and photo entry still using their existing snapshot workflow.
