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

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
    const byOutcome = new Map();
    for (const book of event.bookmakers ?? []) {
      const market = (book.markets ?? []).find((m) => m.key === 'h2h');
      if (!market) continue;
      for (const outcome of market.outcomes ?? []) {
        if (!byOutcome.has(outcome.name)) byOutcome.set(outcome.name, []);
        byOutcome.get(outcome.name).push({ book: book.title, price: outcome.price });
      }
    }
    for (const [selection, prices] of byOutcome) {
      if (prices.length < 3) continue; // need a real market to compare against
      prices.sort((a, b) => b.price - a.price);
      const best = prices[0];
      if (best.price > band.max) continue;
      const mid = median(prices.map((p) => p.price));
      const entry = {
        sport: sportLabel,
        match: `${event.home_team} vs ${event.away_team}`,
        commence: event.commence_time,
        market: 'Head to head',
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
      `&regions=au&markets=h2h&oddsFormat=decimal`;
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
    legs: allLegs.slice(0, 40),
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
      selection: 'Sample Panthers',
      bestOdds: 1.92,
      bestBook: 'PointsBet (sample)',
      nextBest: '1.88 @ Ladbrokes (sample)',
      medianOdds: 1.85,
      valuePct: 3.8,
      booksCompared: 7,
      sample: true,
    },
    // Second side of the same match, priced tight enough that the combined
    // odds still land in-band (1.92 x 1.25 = 2.40) — lets the same-game
    // multi suggestion demo end to end without a live API key.
    {
      sport: 'NRL',
      match: 'Sample Storm vs Sample Panthers',
      commence: new Date(Date.now() + 30 * 3600e3).toISOString(),
      market: 'Alternate line',
      selection: 'Sample Storm',
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

module.exports = { fetchCandidates, SPORTS };
