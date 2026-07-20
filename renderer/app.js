const moneyFmt = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
});

let currentState = null;
let currentBoard = null;
let multiSlip = [];

function combineLegs(legs) {
  const combined = legs.reduce((acc, leg) => acc * leg.odds, 1);
  return Math.round(combined * 100) / 100;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- tiles ---------- */

function settledBets(state) {
  return state.bets
    .filter((b) => b.result !== 'pending')
    .sort((a, b) => new Date(a.settledAt) - new Date(b.settledAt));
}

function profitOf(bet) {
  return bet.result === 'win' ? bet.stake * (bet.odds - 1) : -bet.stake;
}

function renderTiles(state) {
  const settled = settledBets(state);
  const wins = settled.filter((b) => b.result === 'win').length;
  const losses = settled.length - wins;
  const pending = state.bets.length - settled.length;
  const staked = settled.reduce((t, b) => t + b.stake, 0);
  const profit = settled.reduce((t, b) => t + profitOf(b), 0);

  document.getElementById('tile-bankroll').textContent = moneyFmt.format(state.bankroll);
  document.getElementById('tile-bankroll-sub').textContent =
    `started at ${moneyFmt.format(state.startingBankroll)}`;
  document.getElementById('tile-record').textContent = `${wins}–${losses}–${pending}`;
  document.getElementById('tile-roi').textContent =
    staked > 0 ? `${((profit / staked) * 100).toFixed(1)}%` : '—';
  document.getElementById('tile-model').textContent = `v${state.model.version}`;
  document.getElementById('tile-model-sub').textContent =
    state.model.version === 0 ? 'not trained' : state.model.updatedAt;
}

/* ---------- profit chart ---------- */

const CHART_W = 720;
const CHART_H = 220;
const PAD = { top: 14, right: 14, bottom: 22, left: 52 };
let chartPoints = [];

function svgEl(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function renderChart(state) {
  const svg = document.getElementById('chart');
  const empty = document.getElementById('chart-empty');
  svg.replaceChildren();
  chartPoints = [];

  const settled = settledBets(state);
  if (settled.length < 2) {
    empty.hidden = false;
    svg.style.display = 'none';
    return;
  }
  empty.hidden = true;
  svg.style.display = 'block';

  let running = 0;
  let staked = 0;
  const series = settled.map((bet, i) => {
    running += profitOf(bet);
    staked += bet.stake;
    return {
      i,
      profit: Math.round(running * 100) / 100,
      roi: (running / staked) * 100,
      bet,
    };
  });

  const values = series.map((p) => p.profit);
  const yMin = Math.min(0, ...values);
  const yMax = Math.max(0, ...values);
  const ySpan = yMax - yMin || 1;
  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;

  const x = (i) => PAD.left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const y = (v) => PAD.top + (1 - (v - yMin) / ySpan) * plotH;

  // recessive gridlines + labels at min/0/max
  const gridValues = [...new Set([yMin, 0, yMax])];
  for (const gv of gridValues) {
    svg.append(
      svgEl('line', {
        x1: PAD.left,
        x2: CHART_W - PAD.right,
        y1: y(gv),
        y2: y(gv),
        class: gv === 0 ? 'grid grid-zero' : 'grid',
      }),
    );
    const label = svgEl('text', { x: PAD.left - 8, y: y(gv) + 4, class: 'axis-label' });
    label.textContent = moneyFmt.format(gv);
    svg.append(label);
  }

  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.i)},${y(p.profit)}`).join(' ');
  svg.append(svgEl('path', { d: path, class: 'profit-line' }));

  const last = series[series.length - 1];
  svg.append(svgEl('circle', { cx: x(last.i), cy: y(last.profit), r: 4, class: 'profit-dot' }));
  const endLabel = svgEl('text', {
    x: Math.min(x(last.i), CHART_W - PAD.right - 4),
    y: y(last.profit) - 10,
    class: 'end-label',
    'text-anchor': 'end',
  });
  endLabel.textContent = moneyFmt.format(last.profit);
  svg.append(endLabel);

  chartPoints = series.map((p) => ({ ...p, px: x(p.i), py: y(p.profit) }));

  const hoverDot = svgEl('circle', { r: 5, class: 'hover-dot', visibility: 'hidden' });
  svg.append(hoverDot);

  const tip = document.getElementById('chart-tip');
  svg.onmousemove = (event) => {
    const rect = svg.getBoundingClientRect();
    const mx = ((event.clientX - rect.left) / rect.width) * CHART_W;
    let nearest = chartPoints[0];
    for (const p of chartPoints) {
      if (Math.abs(p.px - mx) < Math.abs(nearest.px - mx)) nearest = p;
    }
    hoverDot.setAttribute('cx', nearest.px);
    hoverDot.setAttribute('cy', nearest.py);
    hoverDot.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${new Date(nearest.bet.settledAt).toLocaleDateString('en-AU')} · ${nearest.bet.match} · ${nearest.bet.result === 'win' ? 'won' : 'lost'} · running ${moneyFmt.format(nearest.profit)} (${nearest.roi.toFixed(1)}% on stakes)`;
    tip.style.left = `${Math.min((nearest.px / CHART_W) * rect.width, rect.width - 260)}px`;
  };
  svg.onmouseleave = () => {
    hoverDot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
}

/* ---------- value board ---------- */

function renderBoard(board) {
  currentBoard = board;
  const root = document.getElementById('board');
  const note = document.getElementById('board-note');
  const modeLine = document.getElementById('mode-line');
  root.replaceChildren();

  if (board.source === 'sample') {
    modeLine.textContent = 'Betting lab · SAMPLE DATA — add your Odds API key in Settings for live AU odds';
  } else if (board.source === 'live') {
    modeLine.textContent = `Betting lab · live odds refreshed ${new Date(board.fetchedAt).toLocaleTimeString('en-AU')}`;
  } else {
    modeLine.textContent = 'Betting lab · odds refresh failed';
  }

  if (board.errors?.length) {
    note.textContent = `Some sports failed: ${board.errors.join(' · ')}`;
  }

  if (board.candidates.length === 0) {
    root.append(el('p', 'empty', 'Nothing in the odds band right now — refresh later or widen the band in Settings.'));
    return;
  }

  for (const c of board.candidates) {
    const wrap = el('div', 'pick');

    const head = el('div', 'pick-head');
    const title = el('span', 'pick-match');
    title.append(
      el('span', 'sport-tag', c.sport),
      document.createTextNode(` ${c.match}`),
    );
    head.append(title, el('span', 'pick-odds', `${c.bestOdds.toFixed(2)} @ ${c.bestBook}`));

    const detail = el('p', 'pick-detail',
      `${c.selection} · ${c.market} · median ${c.medianOdds.toFixed(2)} across ${c.booksCompared} books · ` +
      `${c.valuePct > 0 ? '+' : ''}${c.valuePct}% vs market${c.nextBest ? ` · next ${c.nextBest}` : ''}`);

    const research = el('p', 'pick-research',
      'Research pending — form, head-to-head, and matchup deep-dive with Claude before betting.');

    const actions = el('div', 'pick-actions');
    const stake = el('input', 'stake-input');
    stake.type = 'number';
    stake.min = '1';
    stake.value = '10';
    stake.setAttribute('aria-label', `Stake for ${c.selection}`);

    const logBtn = el('button', 'primary', 'Log bet');
    logBtn.addEventListener('click', async () => {
      const amount = Number(stake.value);
      if (!Number.isFinite(amount) || amount <= 0) return;
      currentState = await window.labtech.addBet({
        sport: c.sport,
        match: c.match,
        market: `${c.selection} (${c.market})`,
        selection: c.selection,
        book: c.bestBook,
        odds: c.bestOdds,
        stake: amount,
      });
      renderTiles(currentState);
      renderBets(currentState);
      renderChart(currentState);
    });

    const discordBtn = el('button', null, 'Post to Discord');
    const status = el('span', 'hint');
    discordBtn.addEventListener('click', async () => {
      status.textContent = 'posting…';
      const res = await window.labtech.postToDiscord(c);
      status.textContent = res.ok ? 'posted ✓' : res.error;
    });

    const inSlip = multiSlip.some((leg) => leg.match === c.match && leg.selection === c.selection);
    const blockedMatch = multiSlip.length > 0 && multiSlip[0].match !== c.match;
    const multiBtn = el('button', 'ghost', inSlip ? 'Remove from multi' : 'Add to multi');
    multiBtn.disabled = blockedMatch && !inSlip;
    multiBtn.title = blockedMatch && !inSlip ? 'Same-game multi only — clear the slip to start a new match' : '';
    multiBtn.addEventListener('click', () => {
      if (inSlip) {
        removeFromSlip(c);
      } else {
        addToSlip(c);
      }
    });

    actions.append(stake, logBtn, discordBtn, status, multiBtn);
    wrap.append(head, detail, research, actions);
    root.append(wrap);
  }
}

/* ---------- same-game multi slip ---------- */

function addToSlip(c) {
  if (multiSlip.length > 0 && multiSlip[0].match !== c.match) return;
  if (multiSlip.some((leg) => leg.match === c.match && leg.selection === c.selection)) return;
  multiSlip.push({
    sport: c.sport,
    match: c.match,
    market: c.market,
    selection: c.selection,
    odds: c.bestOdds,
    book: c.bestBook,
  });
  renderMultiSlip();
  renderBoard(currentBoard);
}

function removeFromSlip(c) {
  multiSlip = multiSlip.filter((leg) => !(leg.match === c.match && leg.selection === c.selection));
  renderMultiSlip();
  renderBoard(currentBoard);
}

function renderMultiSlip() {
  const root = document.getElementById('multi-slip');
  root.replaceChildren();

  if (multiSlip.length === 0) {
    root.hidden = true;
    return;
  }
  root.hidden = false;

  root.append(el('h3', 'slip-title', `Same-game multi — ${multiSlip[0].match}`));

  const legs = el('ul', 'bet-legs');
  for (const leg of multiSlip) {
    const item = el('li', null, `${leg.selection} (${leg.market}) @ ${leg.odds.toFixed(2)} — ${leg.book} `);
    const removeBtn = el('button', 'ghost', 'Remove');
    removeBtn.addEventListener('click', () => removeFromSlip(leg));
    item.append(removeBtn);
    legs.append(item);
  }
  root.append(legs);

  const combined = combineLegs(multiSlip);
  const actions = el('div', 'pick-actions');
  actions.append(el('span', 'pick-odds', `Combined odds: ${combined.toFixed(2)}`));

  const stake = el('input', 'stake-input');
  stake.type = 'number';
  stake.min = '1';
  stake.value = '10';
  stake.setAttribute('aria-label', 'Multi stake');

  const logBtn = el('button', 'primary', 'Log same-game multi');
  logBtn.addEventListener('click', async () => {
    const amount = Number(stake.value);
    if (!Number.isFinite(amount) || amount <= 0 || multiSlip.length < 2) return;
    currentState = await window.labtech.addBet({
      sport: multiSlip[0].sport,
      match: multiSlip[0].match,
      market: 'Same-game multi',
      selection: multiSlip.map((leg) => leg.selection).join(' + '),
      book: multiSlip[0].book,
      odds: combined,
      stake: amount,
      type: 'multi',
      legs: multiSlip.map((leg) => `${leg.selection} (${leg.market}) @ ${leg.odds.toFixed(2)}`),
    });
    multiSlip = [];
    renderTiles(currentState);
    renderBets(currentState);
    renderChart(currentState);
    renderMultiSlip();
    renderBoard(currentBoard);
  });
  if (multiSlip.length < 2) logBtn.disabled = true;

  const clearBtn = el('button', 'ghost', 'Clear slip');
  clearBtn.addEventListener('click', () => {
    multiSlip = [];
    renderMultiSlip();
    renderBoard(currentBoard);
  });

  actions.append(stake, logBtn, clearBtn);
  root.append(actions);
}

/* ---------- bet log ---------- */

function renderBets(state) {
  const root = document.getElementById('bets');
  root.replaceChildren();

  if (state.bets.length === 0) {
    root.append(el('p', 'empty', 'No bets logged yet — log a pick to start building history.'));
    return;
  }

  for (const bet of state.bets) {
    const wrap = el('div', 'bet');
    const head = el('div', 'bet-head');
    const title = el('span', 'bet-match');
    if (bet.type === 'multi' || bet.type === 'prop') {
      title.append(el('span', 'type-tag', bet.type === 'multi' ? 'MULTI' : 'PLAYER'));
    }
    title.append(document.createTextNode(`${bet.match} — ${bet.market}`));
    head.append(
      title,
      el('span', 'bet-odds', `${moneyFmt.format(bet.stake)} @ ${bet.odds.toFixed(2)}${bet.book ? ` (${bet.book})` : ''}`),
    );
    wrap.append(head);

    if (bet.legs?.length) {
      const legs = el('ul', 'bet-legs');
      for (const leg of bet.legs) legs.append(el('li', null, leg));
      wrap.append(legs);
    }

    const actions = el('div', 'bet-actions');
    if (bet.result === 'pending') {
      actions.append(el('span', 'status status-pending', 'Pending'));
      const winBtn = el('button', null, 'Won');
      const lossBtn = el('button', null, 'Lost');
      winBtn.addEventListener('click', () => settle(bet.id, 'win'));
      lossBtn.addEventListener('click', () => settle(bet.id, 'loss'));
      actions.append(winBtn, lossBtn);
    } else if (bet.result === 'win') {
      actions.append(el('span', 'status status-win', `✓ Won ${moneyFmt.format(bet.stake * (bet.odds - 1))}`));
    } else {
      actions.append(el('span', 'status status-loss', `✗ Lost ${moneyFmt.format(bet.stake)}`));
    }

    // Taking / Leaving — the user's verdict on each pick, separate from results.
    const takingBtn = el('button', `decide-btn${bet.decision === 'taking' ? ' active-taking' : ''}`, 'Taking');
    const leavingBtn = el('button', `decide-btn${bet.decision === 'leaving' ? ' active-leaving' : ''}`, 'Leaving');
    takingBtn.addEventListener('click', () => decide(bet, 'taking'));
    leavingBtn.addEventListener('click', () => decide(bet, 'leaving'));
    actions.append(takingBtn, leavingBtn);

    if (bet.notes) {
      const whyBtn = el('button', 'why-btn', 'Why ▾');
      const notes = el('p', 'bet-notes', bet.notes);
      notes.hidden = true;
      whyBtn.addEventListener('click', () => {
        notes.hidden = !notes.hidden;
        whyBtn.textContent = notes.hidden ? 'Why ▾' : 'Why ▴';
      });
      actions.append(whyBtn);
      wrap.append(actions, notes);
    } else {
      wrap.append(actions);
    }

    root.append(wrap);
  }
}

async function decide(bet, decision) {
  const next = bet.decision === decision ? null : decision;
  currentState = await window.labtech.decideBet(bet.id, next);
  renderBets(currentState);
}

async function settle(id, result) {
  currentState = await window.labtech.settleBet(id, result);
  renderTiles(currentState);
  renderBets(currentState);
  renderChart(currentState);
}

/* ---------- settings ---------- */

function wireSettings(state) {
  const panel = document.getElementById('settings');
  document.getElementById('settings-toggle').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
  });

  document.getElementById('set-apikey').value = state.settings.oddsApiKey;
  document.getElementById('set-webhook').value = state.settings.discordWebhook;
  document.getElementById('set-min').value = state.settings.minOdds;
  document.getElementById('set-max').value = state.settings.maxOdds;

  document.getElementById('settings-save').addEventListener('click', async () => {
    currentState = await window.labtech.saveSettings({
      oddsApiKey: document.getElementById('set-apikey').value.trim(),
      discordWebhook: document.getElementById('set-webhook').value.trim(),
      minOdds: Number(document.getElementById('set-min').value) || 1.7,
      maxOdds: Number(document.getElementById('set-max').value) || 2.5,
    });
    document.getElementById('settings-status').textContent = 'saved ✓ — refreshing odds…';
    const board = await window.labtech.refreshOdds();
    renderBoard(board);
    document.getElementById('settings-status').textContent = 'saved ✓';
  });
}

/* ---------- init ---------- */

async function init() {
  currentState = await window.labtech.getState();
  renderTiles(currentState);
  renderBets(currentState);
  renderChart(currentState);
  wireSettings(currentState);

  document.getElementById('refresh-odds').addEventListener('click', async () => {
    document.getElementById('mode-line').textContent = 'Betting lab · refreshing odds…';
    renderBoard(await window.labtech.refreshOdds());
  });

  renderBoard(await window.labtech.refreshOdds());
}

init();
