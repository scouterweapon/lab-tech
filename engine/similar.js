// Dedup logic: once a pick from a match is decided (taken or left), similar
// picks from that same match are noisy — hide them from the value board for
// a cooldown window instead of showing redundant/contradictory outcomes.

const { learnedScore } = require('./learning');

const SUPPRESS_MS = 5 * 60 * 1000;

function matchKey(match) {
  return String(match).trim().toLowerCase();
}

function suppressSimilar(suppressed, match, now = Date.now(), ms = SUPPRESS_MS) {
  suppressed[matchKey(match)] = now + ms;
  return suppressed;
}

function pruneExpired(suppressed, now = Date.now()) {
  for (const key of Object.keys(suppressed)) {
    if (suppressed[key] <= now) delete suppressed[key];
  }
  return suppressed;
}

function applySuppression(candidates, suppressed, now = Date.now()) {
  pruneExpired(suppressed, now);
  return candidates.filter((c) => !suppressed[matchKey(c.match)]);
}

function combineLegs(legs) {
  const combined = legs.reduce((acc, leg) => acc * Number(leg.odds), 1);
  return Math.round(combined * 100) / 100;
}

// A "leaving" verdict gets a thinking window, then the entry is dropped for good.
function pruneLeftBets(bets, now = Date.now(), ttlMs = SUPPRESS_MS) {
  return bets.filter(
    (b) => !(b.decision === 'leaving' && b.decidedAt && now - new Date(b.decidedAt).getTime() >= ttlMs),
  );
}

// Picks the best same-game multi on the board — legs must share a match,
// and the COMBINED odds (not each leg) must fall inside minOdds/maxOdds.
// Ranking uses the model's learned score when given one, so the pick gets
// smarter as more bets settle; otherwise falls back to raw market value%.
// If no match has an in-band 2+ leg combo, returns the single best-value
// pick as a starter so there's still something to build from.
function suggestMulti(candidates, { minOdds, maxOdds, model } = {}) {
  const groups = new Map();
  for (const c of candidates) {
    if (!groups.has(c.match)) groups.set(c.match, []);
    groups.get(c.match).push(c);
  }

  const toLeg = (c) => ({
    sport: c.sport,
    match: c.match,
    market: c.market,
    selection: c.selection,
    odds: c.bestOdds,
    book: c.bestBook,
  });

  const scoreOf = (betLike) => (model ? learnedScore(betLike, model) : (betLike.valuePct || 0) / 100);

  let best = null;
  for (const cands of groups.values()) {
    if (cands.length < 2) continue;
    const legs = cands.map(toLeg);
    const combined = combineLegs(legs);
    if (minOdds != null && combined < minOdds) continue;
    if (maxOdds != null && combined > maxOdds) continue;
    const valueScore = cands.reduce((sum, c) => sum + c.valuePct, 0);
    const score = scoreOf({ type: 'multi', sport: legs[0].sport, odds: combined, valuePct: valueScore });
    if (!best || score > best.score) {
      best = { legs, combined, valueScore, score, single: false };
    }
  }
  if (best) return best;

  let top = null;
  let topScore = -Infinity;
  for (const c of candidates) {
    const score = scoreOf({ type: 'single', sport: c.sport, odds: c.bestOdds, valuePct: c.valuePct });
    if (score > topScore) {
      topScore = score;
      top = c;
    }
  }
  if (!top) return null;
  return { legs: [toLeg(top)], combined: top.bestOdds, valueScore: top.valuePct, score: topScore, single: true };
}

// Stops the same combo of legs on the same match being logged twice.
function isDuplicateMulti(bets, suggestion) {
  const sig = suggestion.legs
    .map((leg) => leg.selection)
    .sort()
    .join('|');
  return bets.some(
    (b) =>
      b.type === 'multi' &&
      b.match === suggestion.legs[0].match &&
      Array.isArray(b.legs) &&
      b.legs.length === suggestion.legs.length &&
      b.legs
        .map((leg) => leg.split(' (')[0])
        .sort()
        .join('|') === sig,
  );
}

module.exports = {
  SUPPRESS_MS,
  matchKey,
  suppressSimilar,
  pruneExpired,
  applySuppression,
  combineLegs,
  pruneLeftBets,
  suggestMulti,
  isDuplicateMulti,
};
