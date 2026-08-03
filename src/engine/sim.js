/* Batch simulation — "how does my deck stack up against the field?"
 *
 * This is the whole reason the engine is headless. Nothing here touches the
 * DOM or a timer, so a few thousand games run in a fraction of a second and the
 * result is reproducible from the seed.
 *
 * Every matchup is played on BOTH sides of the die: each seed is run once with
 * the deck on the play and once on the draw. Going first is a real advantage in
 * this game, so a one-sided sample would flatter whichever deck got it.
 */

import { createGame, apply } from './engine.js';
import { decide, SKILL } from './ai.js';

const MAX_ACTIONS = 4000;   // a game this long is a stalled state, not a real one

/** Play one game to completion. Returns the winner and why it ended. */
export function playGame({ p1, p2, cards, seed, firstPlayer = 'p1', skill = SKILL.solid }) {
  const G = createGame({ p1, p2, cards, seed, firstPlayer });
  let n = 0;
  while (!G.over && n++ < MAX_ACTIONS) {
    const action = decide(G, skill);
    if (!action) break;
    apply(G, action);
  }
  return {
    winner: G.over?.winner ?? null,
    reason: G.over?.reason ?? 'game did not resolve',
    turns: G.turn,
    stalled: !G.over,
  };
}

/**
 * Run `games` matches between two decks, alternating who goes first.
 * @returns {{wins,losses,draws,games,winRate,onPlay,onDraw,avgTurns,stalled,ci95}}
 */
export function runMatchup({ deck, opponent, cards, games = 200, seed = 1, skill = SKILL.solid }) {
  let wins = 0, stalled = 0, turnSum = 0;
  const onPlay = { wins: 0, games: 0 };
  const onDraw = { wins: 0, games: 0 };

  for (let i = 0; i < games; i++) {
    // Alternate the die roll so neither deck keeps the first-player advantage.
    const weGoFirst = i % 2 === 0;
    const r = playGame({
      p1: { name: 'deck', leaderId: deck.leader, deck: deck.cards },
      p2: { name: 'opponent', leaderId: opponent.leader, deck: opponent.cards },
      cards,
      seed: seed + i,
      firstPlayer: weGoFirst ? 'p1' : 'p2',
      skill,
    });
    const bucket = weGoFirst ? onPlay : onDraw;
    bucket.games++;
    turnSum += r.turns;
    if (r.stalled) stalled++;
    if (r.winner === 'p1') { wins++; bucket.wins++; }
  }

  const played = games - stalled;
  const winRate = played ? wins / played : 0;

  return {
    games, wins, losses: played - wins, stalled,
    winRate,
    ci95: wilson95(wins, played),
    onPlay: onPlay.games ? onPlay.wins / onPlay.games : 0,
    onDraw: onDraw.games ? onDraw.wins / onDraw.games : 0,
    avgTurns: games ? turnSum / games : 0,
  };
}

/**
 * Play one deck against every archetype in the field.
 * `field` is `[{ key, name, leader, cards, share }]`.
 */
export function runGauntlet({ deck, field, cards, games = 200, seed = 1, skill = SKILL.solid, onProgress }) {
  const rows = [];
  for (let i = 0; i < field.length; i++) {
    const opp = field[i];
    const r = runMatchup({ deck, opponent: opp, cards, games, seed, skill });
    rows.push({ key: opp.key, name: opp.name, leader: opp.leader, share: opp.share ?? null, ...r });
    onProgress?.(i + 1, field.length, rows[rows.length - 1]);
  }

  // Weight by how much of the field each archetype actually represents, so a
  // 25%-share matchup counts for more than a 1% one.
  const totalShare = rows.reduce((a, r) => a + (r.share || 0), 0);
  const weighted = totalShare > 0
    ? rows.reduce((a, r) => a + r.winRate * (r.share || 0), 0) / totalShare
    : rows.reduce((a, r) => a + r.winRate, 0) / (rows.length || 1);

  return {
    rows: rows.sort((a, b) => b.winRate - a.winRate),
    overall: rows.length ? rows.reduce((a, r) => a + r.winRate, 0) / rows.length : 0,
    fieldWeighted: weighted,
    games,
  };
}

/* Wilson score interval — honest error bars on a proportion at small N.
 * A naive ±1/sqrt(n) badly understates uncertainty near 0% or 100%. */
export function wilson95(wins, n) {
  if (!n) return [0, 0];
  const z = 1.959964;
  const p = wins / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}
