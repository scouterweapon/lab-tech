// Dedup logic: once a pick from a match is decided (taken or left), similar
// picks from that same match are noisy — hide them from the value board for
// a cooldown window instead of showing redundant/contradictory outcomes.

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

module.exports = { SUPPRESS_MS, matchKey, suppressSimilar, pruneExpired, applySuppression, combineLegs };
