// Player identity across frames. Decides which seat in each frame is which
// person, so comparisons follow people rather than screen positions. Pure and
// deterministic. It never merges two players on weak evidence: a seat that
// cannot be placed stays unmatched, with candidates, until the user decides.
import type { ScreenshotRecognition } from '../vision/screenshot.js';
import { seatName } from './observation.js';
import type {
  FrameIdentity, HandObservation, IdentityInput, IdentityIssue, IdentityOverride, IdentityResult, MatchBasis,
  SeatIdentity, SeatPairing, TrackedPlayer,
} from './types.js';

/** Override value meaning "this seat is someone not seen before". */
export const NEW_PLAYER = 'new';

const norm = (s: string | null) => s?.trim().toLowerCase().replace(/\s+/g, ' ') || null;

/**
 * How seats line up by order alone: later seat k is earlier seat
 * (k + rotation) mod n, using names where both frames show them. `null` when
 * the seat counts differ or no rotation agrees with every visible name.
 */
export function alignSeats(prev: ScreenshotRecognition, next: ScreenshotRecognition): number | null {
  const n = prev.players.length;
  if (n !== next.players.length || n === 0) return null;
  const fits = (r: number) => next.players.every((p, k) => {
    const a = norm(p.name.value);
    const b = norm(prev.players[(k + r) % n].name.value);
    return a === null || b === null || a === b;
  });
  for (let r = 0; r < n; r++) if (fits(r)) return r;
  return null;
}

/** A pairing for two frames compared on their own, by seat order and names (no tracked identities). */
export function pairByOrder(prev: ScreenshotRecognition, next: ScreenshotRecognition): SeatPairing | null {
  const r = alignSeats(prev, next);
  if (r === null) return null;
  const n = prev.players.length;
  const id = (i: number) => 'seat-' + (i + 1);
  return {
    pairs: prev.players.map((_, i) => ({ prev: i, next: (i - r + n) % n, playerId: id(i) })),
    gone: [], arrived: [], unmatched: [],
    dealer: [
      prev.dealerSeat.value === null ? null : id(prev.dealerSeat.value),
      next.dealerSeat.value === null ? null : id((next.dealerSeat.value + r) % n),
    ],
  };
}

interface Working {
  seat: number;
  playerId: string | null;
  basis: MatchBasis;
  candidates: string[];
}

/**
 * Track players through frames in order. For each frame, a seat is matched by,
 * in turn: the user's override, a visible name, the user's own seat, and the
 * seat position relative to already-matched players (only when the table size
 * is unchanged and the matched players agree on one rotation). Anything left
 * is a new player in the first frame or when no known player is free;
 * otherwise it stays unmatched with ranked candidates. Players seen earlier
 * but not placed in a frame are listed as missing, never as folded.
 */
export function trackPlayers(observations: readonly HandObservation[], input: IdentityInput = {}): IdentityResult {
  const list = [...observations].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
  const players = new Map<string, { id: string; label: string; firstObservation: string }>();
  const lastStack = new Map<string, number>();
  const seen = new Set<string>();
  /** Visible name → player, including names first read after the player was matched by position. */
  const alias = new Map<string, string>();
  /** Names each player has been seen with. */
  const namesOf = new Map<string, Set<string>>();
  const frames: FrameIdentity[] = [];
  const issues: IdentityIssue[] = [];
  let prev: { seats: Working[]; n: number } | null = null;
  let lastHero: string | null = null;

  list.forEach((obs, frameIndex) => {
    const rec = obs.recognition;
    const n = rec.players.length;
    const frameLabel = 'frame ' + (obs.sequenceIndex + 1);
    const seats: (Working | null)[] = new Array(n).fill(null);
    const taken = new Map<string, number>();
    const labelOf = (id: string) => players.get(id)?.label ?? id;
    const create = (id: string, s: number) => {
      if (!players.has(id)) {
        const name = rec.players[s].name.value;
        const label = name ?? (rec.heroSeat.value === s ? 'You' : seatName(rec, s) + ' (' + frameLabel + ')');
        players.set(id, { id, label, firstObservation: obs.id });
      }
    };
    const assign = (s: number, id: string, basis: MatchBasis) => {
      if (taken.has(id)) {
        issues.push({
          kind: 'conflict', observationId: obs.id, seat: s, playerId: id,
          text: labelOf(id) + ' is matched to two seats in ' + frameLabel + ' (seats ' + (taken.get(id)! + 1) + ' and ' + (s + 1) + '). Fix a name or a match.',
        });
        seats[s] = { seat: s, playerId: null, basis: 'unmatched', candidates: [id] };
        return;
      }
      taken.set(id, s);
      seats[s] = { seat: s, playerId: id, basis, candidates: [] };
    };

    // 1. The user's matches.
    for (const o of input.overrides ?? []) {
      if (o.observationId !== obs.id || o.seat < 0 || o.seat >= n || seats[o.seat]) continue;
      if (o.playerId === NEW_PLAYER) {
        const id = 'new:' + obs.id + ':' + o.seat;
        create(id, o.seat);
        assign(o.seat, id, 'user');
      } else if (players.has(o.playerId)) {
        assign(o.seat, o.playerId, 'user');
      } else {
        issues.push({ kind: 'conflict', observationId: obs.id, seat: o.seat, text: 'A saved match for seat ' + (o.seat + 1) + ' in ' + frameLabel + ' refers to a player who is not in the earlier frames.' });
      }
    }
    // 2. Visible names already linked to a player. A name seen for the first time waits for step 4,
    // because it may belong to a player matched earlier by position.
    const fresh: number[] = [];
    rec.players.forEach((p, s) => {
      const key = norm(p.name.value);
      if (seats[s] || !key) return;
      const id = alias.get(key);
      if (id) assign(s, id, 'name');
      else fresh.push(s);
    });
    if (!prev) {
      for (const s of fresh) {
        const id = 'name:' + norm(rec.players[s].name.value);
        create(id, s);
        assign(s, id, 'new');
      }
      fresh.length = 0;
    }
    // 3. The user's own seat.
    const heroSeat = rec.heroSeat.value;
    if (heroSeat !== null && heroSeat < n && !seats[heroSeat] && lastHero && !taken.has(lastHero)) assign(heroSeat, lastHero, 'hero');
    // 4. Position, relative to players already matched, when the table size is unchanged.
    if (prev && prev.n === n) {
      const prevSeatOf = new Map(prev.seats.filter(w => w.playerId).map(w => [w.playerId!, w.seat]));
      const offsets = new Set<number>();
      seats.forEach((w, s) => {
        if (w?.playerId && prevSeatOf.has(w.playerId)) offsets.add((prevSeatOf.get(w.playerId)! - s + n) % n);
      });
      const r = offsets.size === 1 ? [...offsets][0] : offsets.size === 0 ? 0 : null;
      if (r !== null) {
        for (let s = 0; s < n; s++) {
          if (seats[s]) continue;
          const candidate = prev.seats[(s + r) % n]?.playerId;
          const key = norm(rec.players[s].name.value);
          // Never place a named seat on a player already known by another name.
          const clash = key !== null && [...(namesOf.get(candidate ?? '') ?? [])].some(other => other !== key);
          if (candidate && !taken.has(candidate) && !clash) assign(s, candidate, 'position');
        }
      } else {
        issues.push({ kind: 'ambiguous', observationId: obs.id, seat: null, text: 'The named players in ' + frameLabel + ' moved by different amounts, so seat positions are not used to match the others.' });
      }
    }
    // New names that position did not place belong to new players.
    for (const s of fresh) {
      if (seats[s]) continue;
      const id = 'name:' + norm(rec.players[s].name.value);
      create(id, s);
      assign(s, id, players.get(id)?.firstObservation === obs.id ? 'new' : 'name');
    }
    // 5. Whatever is left.
    for (let s = 0; s < n; s++) {
      if (seats[s]) continue;
      const free = [...players.keys()].filter(id => !taken.has(id) && seen.has(id));
      if (frameIndex === 0 || free.length === 0) {
        const id = 'seat:' + obs.id + ':' + s;
        create(id, s);
        assign(s, id, 'new');
        continue;
      }
      // Rank: a stack can only fall without a pot award, so a candidate whose last stack is at least this one comes first.
      const stack = rec.players[s].stack.value;
      const plausible = (id: string) => (stack === null || !lastStack.has(id) ? 1 : lastStack.get(id)! >= stack ? 0 : 2);
      const candidates = free.sort((a, b) => plausible(a) - plausible(b) || a.localeCompare(b));
      seats[s] = { seat: s, playerId: null, basis: 'unmatched', candidates };
      issues.push({
        kind: 'ambiguous', observationId: obs.id, seat: s,
        text: seatName(rec, s) + ' in ' + frameLabel + ' could be ' + candidates.map(labelOf).join(' or ') + ', or someone new. Match the seat to settle it.',
      });
    }

    const final = seats as Working[];
    const missing = [...seen].filter(id => !taken.has(id)).map(playerId => ({
      playerId, acknowledged: (input.hidden ?? []).some(h => h.observationId === obs.id && h.playerId === playerId),
    }));
    for (const m of missing) {
      if (!m.acknowledged) {
        issues.push({ kind: 'missing', observationId: obs.id, seat: null, playerId: m.playerId, text: labelOf(m.playerId) + ' is not visible in ' + frameLabel + '. That is not a fold: mark them as not visible, or match them to a seat.' });
      }
    }
    final.forEach(w => {
      if (!w.playerId) return;
      seen.add(w.playerId);
      const p = rec.players[w.seat];
      if (p.stack.value !== null) lastStack.set(w.playerId, p.stack.value);
      const key = norm(p.name.value);
      if (key) {
        players.set(w.playerId, { ...players.get(w.playerId)!, label: p.name.value! });
        if (!alias.has(key)) alias.set(key, w.playerId);
        namesOf.set(w.playerId, new Set([...(namesOf.get(w.playerId) ?? []), key]));
      }
    });
    const idAt = (s: number | null) => (s === null || s >= n ? null : final[s].playerId);
    const hero = idAt(heroSeat);
    if (hero) lastHero = hero;
    frames.push({
      observationId: obs.id,
      seats: final.map(w => ({ seat: w.seat, playerId: w.playerId, basis: w.basis, candidates: w.candidates } satisfies SeatIdentity)),
      dealer: idAt(rec.dealerSeat.value),
      hero,
      missing,
    });
    prev = { seats: final, n };
  });

  return { players: [...players.values()] satisfies TrackedPlayer[], frames, issues };
}

/** How two frames of a tracked sequence line up, player by player. */
export function seatPairing(identity: IdentityResult, prevId: string, nextId: string): SeatPairing {
  const a = identity.frames.find(f => f.observationId === prevId);
  const b = identity.frames.find(f => f.observationId === nextId);
  if (!a || !b) return { pairs: [], gone: [], arrived: [], unmatched: [], dealer: [null, null] };
  const nextSeat = new Map(b.seats.filter(s => s.playerId).map(s => [s.playerId!, s.seat]));
  const prevSeat = new Map(a.seats.filter(s => s.playerId).map(s => [s.playerId!, s.seat]));
  const first = new Map(identity.players.map(p => [p.id, p.firstObservation]));
  return {
    pairs: a.seats.filter(s => s.playerId && nextSeat.has(s.playerId)).map(s => ({ prev: s.seat, next: nextSeat.get(s.playerId!)!, playerId: s.playerId! })),
    gone: a.seats.filter(s => s.playerId && !nextSeat.has(s.playerId)).map(s => ({
      seat: s.seat, playerId: s.playerId!, acknowledged: b.missing.some(m => m.playerId === s.playerId && m.acknowledged),
    })),
    arrived: b.seats.filter(s => s.playerId && !prevSeat.has(s.playerId)).map(s => ({
      seat: s.seat, playerId: s.playerId!, firstSeen: first.get(s.playerId!) === nextId,
    })),
    unmatched: b.seats.filter(s => !s.playerId).map(s => s.seat),
    dealer: [a.dealer, b.dealer],
  };
}

/** Keep the user's seat matches on the same people after a frame's seats were reordered (`map[old] = new`). */
export function remapOverrides(overrides: readonly IdentityOverride[], observationId: string, map: readonly number[]): IdentityOverride[] {
  return overrides.map(o => (o.observationId !== observationId || map[o.seat] === undefined ? o : { ...o, seat: map[o.seat] }));
}

/** Set (or with `playerId` null, clear) the user's match for one seat. */
export function setOverride(overrides: readonly IdentityOverride[], observationId: string, seat: number, playerId: string | null): IdentityOverride[] {
  const others = overrides.filter(o => !(o.observationId === observationId && o.seat === seat));
  return playerId === null ? others : [...others, { observationId, seat, playerId }];
}
