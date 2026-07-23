// Odds aggregation across the big Australian bookmakers, via The Odds API
// (the-odds-api.com) — its AU region covers Sportsbet, Bet365, Ladbrokes,
// PointsBet, Neds, TAB, Unibet and more. Free key required (500 credits/mo);
// each refresh costs one credit per sport.
//
// The learning loop plugs in here later: settled-bet history should reweight
// which factors (form, H2H, matchup) actually predicted profit.

const SPORTS = [
  { key: 'basketball_nba', label: 'NBA' },
  { key: 'rugbyleague_nrl', label: 'NRL' },
  { key: 'aussierules_afl', label: 'AFL' },
  { key: 'soccer_epl', label: 'Soccer · EPL' },
  { key: 'soccer_australia_aleague', label: 'Soccer · A-League' },
];

// h2h/spreads/totals are three DIFFERENT markets on the same match — a real
// same-game multi combines legs across these, e.g. "Team A to win" + "Over
// 45.5 points". Combining the two outcomes WITHIN one market (Team A vs
// Team B, or Over vs Under) is not a multi, it's betting against yourself:
// exactly one of them always loses. suggestMulti (engine/similar.js) relies
// on every leg here carrying a marketKey so it can enforce "one leg per
// market type, per match" and never pair up two sides of the same market.
const MARKET_LABELS = { h2h: 'Head to head', spreads: 'Line', totals: 'Total points' };

// The Odds API has no concept of "this week's round" — the closest real
// proxy is "kicks off within the next 7 days from now," which is what this
// enforces. Keeps the board to the current round instead of fixtures weeks
// out (e.g. an EPL match a month away sitting next to tonight's NRL game).
const CURRENT_WEEK_MS = 7 * 24 * 3600 * 1000;

function isWithinCurrentWeek(commenceTime, now = Date.now()) {
  const t = new Date(commenceTime).getTime();
  return t >= now && t <= now + CURRENT_WEEK_MS;
}

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function outcomeSelection(marketKey, outcome) {
  if (marketKey === 'h2h') return outcome.name;
  if (outcome.point == null) return outcome.name;
  return `${outcome.name} ${outcome.point > 0 ? '+' : ''}${outcome.point}`;
}

// Two pools come out of the same market data. `candidates` is the value
// board: single bets, each already priced inside the user's min/max band.
// `legs` is wider — anything up to the band max, including short-priced
// favourites that are no good alone but are exactly what a same-game multi
// is built from. Two legs each >= band.min would multiply past band.max
// every time (1.70 x 1.70 = 2.89), so the multi suggester needs this
// separate, lower-floor pool to ever find an in-band combination.
function candidatesFromEvents(events, sportLabel, band) {
  const candidates = [];
  const legs = [];
  for (const event of events) {
    if (!isWithinCurrentWeek(event.commence_time)) continue;
    // key: `${marketKey}|${selection}` -> accumulated book prices
    const byOutcome = new Map();
    for (const book of event.bookmakers ?? []) {
      for (const market of book.markets ?? []) {
        if (!MARKET_LABELS[market.key]) continue;
        for (const outcome of market.outcomes ?? []) {
          const selection = outcomeSelection(market.key, outcome);
          const key = `${market.key}|${selection}`;
          if (!byOutcome.has(key)) byOutcome.set(key, { marketKey: market.key, selection, prices: [] });
          byOutcome.get(key).prices.push({ book: book.title, price: outcome.price });
        }
      }
    }
    for (const { marketKey, selection, prices } of byOutcome.values()) {
      if (prices.length < 3) continue; // need a real market to compare against
      prices.sort((a, b) => b.price - a.price);
      const best = prices[0];
      if (best.price > band.max) continue;
      const mid = median(prices.map((p) => p.price));
      const entry = {
        sport: sportLabel,
        match: `${event.home_team} vs ${event.away_team}`,
        commence: event.commence_time,
        market: MARKET_LABELS[marketKey],
        marketKey,
        selection,
        bestOdds: best.price,
        bestBook: best.book,
        nextBest: prices[1] ? `${prices[1].price.toFixed(2)} @ ${prices[1].book}` : null,
        medianOdds: Math.round(mid * 100) / 100,
        valuePct: Math.round((best.price / mid - 1) * 1000) / 10,
        booksCompared: prices.length,
      };
      legs.push(entry);
      if (best.price >= band.min) candidates.push(entry);
    }
  }
  return { candidates, legs };
}

async function fetchCandidates(settings) {
  const band = {
    min: Number(settings.minOdds) || 1.7,
    max: Number(settings.maxOdds) || 2.5,
  };

  if (!settings.oddsApiKey) {
    const sample = sampleCandidates(band);
    return { source: 'sample', fetchedAt: new Date().toISOString(), candidates: sample.candidates, legs: sample.legs };
  }

  const allCandidates = [];
  const allLegs = [];
  const errors = [];
  for (const sport of SPORTS) {
    const url =
      `https://api.the-odds-api.com/v4/sports/${sport.key}/odds/` +
      `?apiKey=${encodeURIComponent(settings.oddsApiKey)}` +
      `&regions=au&markets=h2h,spreads,totals&oddsFormat=decimal`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        errors.push(`${sport.label}: HTTP ${res.status}`);
        continue;
      }
      const events = await res.json();
      const { candidates, legs } = candidatesFromEvents(events, sport.label, band);
      allCandidates.push(...candidates);
      allLegs.push(...legs);
    } catch (err) {
      errors.push(`${sport.label}: ${err.message}`);
    }
  }

  allCandidates.sort((a, b) => b.valuePct - a.valuePct);
  return {
    source: allCandidates.length > 0 || allLegs.length > 0 ? 'live' : 'error',
    fetchedAt: new Date().toISOString(),
    errors,
    candidates: allCandidates.slice(0, 15),
    legs: allLegs.slice(0, 60),
  };
}

// Shown until an API key is configured, so the whole flow is testable.
function sampleCandidates(band) {
  const all = [
    {
      sport: 'NBA',
      match: 'Sample Celtics vs Sample Lakers',
      commence: new Date(Date.now() + 8 * 3600e3).toISOString(),
      market: 'Head to head',
      marketKey: 'h2h',
      selection: 'Sample Celtics',
      bestOdds: 2.1,
      bestBook: 'Sportsbet (sample)',
      nextBest: '2.05 @ Bet365 (sample)',
      medianOdds: 2.0,
      valuePct: 5.0,
      booksCompared: 6,
      sample: true,
    },
    {
      sport: 'NRL',
      match: 'Sample Storm vs Sample Panthers',
      commence: new Date(Date.now() + 30 * 3600e3).toISOString(),
      market: 'Head to head',
      marketKey: 'h2h',
      selection: 'Sample Panthers',
      bestOdds: 1.92,
      bestBook: 'PointsBet (sample)',
      nextBest: '1.88 @ Ladbrokes (sample)',
      medianOdds: 1.85,
      valuePct: 3.8,
      booksCompared: 7,
      sample: true,
    },
    // A DIFFERENT market on the same match (totals, not h2h) — a legitimate
    // second leg. Combined with Panthers above: 1.92 x 1.25 = 2.40, in-band.
    {
      sport: 'NRL',
      match: 'Sample Storm vs Sample Panthers',
      commence: new Date(Date.now() + 30 * 3600e3).toISOString(),
      market: 'Total points',
      marketKey: 'totals',
      selection: 'Over 43.5',
      bestOdds: 1.25,
      bestBook: 'TAB (sample)',
      nextBest: '1.20 @ Sportsbet (sample)',
      medianOdds: 1.22,
      valuePct: 2.5,
      booksCompared: 7,
      sample: true,
    },
    {
      sport: 'AFL',
      match: 'Sample Magpies vs Sample Cats',
      commence: new Date(Date.now() + 50 * 3600e3).toISOString(),
      market: 'Head to head',
      marketKey: 'h2h',
      selection: 'Sample Cats',
      bestOdds: 2.35,
      bestBook: 'Ladbrokes (sample)',
      nextBest: '2.30 @ TAB (sample)',
      medianOdds: 2.25,
      valuePct: 4.4,
      booksCompared: 5,
      sample: true,
    },
  ];
  return {
    candidates: all.filter((c) => c.bestOdds >= band.min && c.bestOdds <= band.max),
    legs: all.filter((c) => c.bestOdds <= band.max),
  };
}

module.exports = { fetchCandidates, SPORTS, isWithinCurrentWeek };
