// Minimal, explainable learning loop. Every settled bet — single, multi, or
// prop — gets bucketed by traits that might carry signal (bet type, sport,
// odds range), and running win/ROI stats per bucket blend with live market
// value to rank future picks. No black box: every number traces back to a
// real settled bet in this file's history.

function oddsBand(odds) {
  if (odds < 1.9) return '1.70-1.89';
  if (odds < 2.1) return '1.90-2.09';
  if (odds < 2.3) return '2.10-2.29';
  return '2.30-2.50';
}

function factorKeysFor(betLike) {
  return [`type:${betLike.type}`, `sport:${betLike.sport || 'unknown'}`, `odds:${oddsBand(betLike.odds)}`];
}

function learnFromSettledBet(model, bet) {
  const factors = { ...model.factors };
  const profit = bet.result === 'win' ? bet.stake * (bet.odds - 1) : -bet.stake;
  for (const key of factorKeysFor(bet)) {
    const prev = factors[key] || { wins: 0, losses: 0, staked: 0, profit: 0, n: 0 };
    factors[key] = {
      wins: prev.wins + (bet.result === 'win' ? 1 : 0),
      losses: prev.losses + (bet.result === 'loss' ? 1 : 0),
      staked: Math.round((prev.staked + bet.stake) * 100) / 100,
      profit: Math.round((prev.profit + profit) * 100) / 100,
      n: prev.n + 1,
    };
  }
  return {
    version: model.version + 1,
    updatedAt: new Date().toISOString(),
    factors,
    note: 'Learning from settled bet history — see factors for per-bucket win rate and ROI.',
  };
}

// Blend live market value% with this bucket's real track record. Buckets
// with little or no history fall back toward raw market value so a
// cold-start model doesn't just refuse to suggest anything; confidence
// ramps up to full trust in the learned ROI once a bucket has ~20 bets.
function learnedScore(betLike, model) {
  let weightedRoi = 0;
  let weight = 0;
  for (const key of factorKeysFor(betLike)) {
    const f = model.factors[key];
    if (!f || f.staked <= 0) continue;
    weightedRoi += (f.profit / f.staked) * f.n;
    weight += f.n;
  }
  const learnedRoi = weight > 0 ? weightedRoi / weight : 0;
  const confidence = Math.min(weight / 20, 1);
  const baseline = (betLike.valuePct || 0) / 100;
  return baseline * (1 - confidence) + learnedRoi * confidence;
}

// Bankroll and the model are both derived from the shared bets table on
// every read rather than stored as separately-mutated fields. With two
// installs writing to the same cloud ledger, a stored, incrementally
// updated number can lose an update if both sides settle a bet at once;
// a value computed fresh from the full (consistent, server-side) history
// can't drift out of sync the same way.
function computeBankroll(startingBankroll, bets) {
  const profit = bets.reduce((total, bet) => {
    if (bet.result === 'win') return total + bet.stake * (bet.odds - 1);
    if (bet.result === 'loss') return total - bet.stake;
    return total;
  }, 0);
  return Math.round((startingBankroll + profit) * 100) / 100;
}

function computeModel(bets) {
  const settled = bets
    .filter((b) => b.result === 'win' || b.result === 'loss')
    .sort((a, b) => new Date(a.settledAt) - new Date(b.settledAt));

  let model = { version: 0, updatedAt: null, factors: {} };
  for (const bet of settled) {
    model = learnFromSettledBet(model, bet);
  }
  if (settled.length === 0) {
    model.note = 'No settled bets yet — the model learns win rate and ROI per odds/sport/type bucket as bets settle.';
  }
  return model;
}

module.exports = { oddsBand, factorKeysFor, learnFromSettledBet, learnedScore, computeBankroll, computeModel };
