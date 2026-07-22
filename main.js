const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');
const { fetchCandidates } = require('./engine/odds');
const {
  suppressSimilar,
  applySuppression,
  isPastLeaveWindow,
  suggestMulti,
  isDuplicateMulti,
} = require('./engine/similar');
const { computeBankroll, computeModel } = require('./engine/learning');
const { loadHypotheses, matchingHypothesisIds } = require('./engine/brain');
const cloud = require('./engine/cloud');

const DEFAULT_AUTO_STAKE = 10;
// ~96 refreshes/day so a month of unattended running (5 sports, 1 credit
// each) costs about 14,400 Odds API credits — inside the $30/mo 20K plan
// with room to spare. Free while running on sample data (no network call).
const AUTO_REFRESH_MS = 15 * 60 * 1000;

const DEFAULT_SETTINGS = {
  oddsApiKey: '',
  discordWebhook: '',
  minOdds: 1.7,
  maxOdds: 2.5,
  // Off by default — during the trial phase, qualifying multis wait for a
  // manual "Use suggested multi" click. Flip on once you trust the calls.
  autoLogQualifyingMultis: false,
};

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow;
// Board dedup only — which match to hide from the value board for a bit.
// Kept local per install; it's a UI convenience, not shared ledger data.
const suppressed = {};

// Bets, bankroll, settings and the model all live in Supabase now, shared
// by every Lab Tech install. This assembles the same shape the renderer
// always expected, fresh from the shared source of truth on every call.
async function loadFullState() {
  const [bets, appState] = await Promise.all([cloud.fetchBets(), cloud.fetchAppState()]);
  const settings = { ...DEFAULT_SETTINGS, ...appState.settings };
  return {
    startingBankroll: appState.startingBankroll,
    bankroll: computeBankroll(appState.startingBankroll, bets),
    bets,
    suppressed,
    settings,
    model: computeModel(bets),
  };
}

async function broadcastState() {
  if (!mainWindow) return;
  try {
    mainWindow.webContents.send('state:updated', await loadFullState());
  } catch (err) {
    console.error('broadcastState failed:', err.message);
  }
}

// A "leaving" verdict gets a 5-minute thinking window, then it's deleted
// from the shared ledger for good — checked well inside that window so it
// disappears for both installs at roughly the same time.
async function sweepLeftBets() {
  let bets;
  try {
    bets = await cloud.fetchBets();
  } catch (err) {
    console.error('sweepLeftBets fetch failed:', err.message);
    return false;
  }
  const expired = bets.filter((b) => isPastLeaveWindow(b));
  for (const bet of expired) {
    await cloud.deleteBetRow(bet.id).catch((err) => console.error('sweepLeftBets delete failed:', err.message));
  }
  return expired.length > 0;
}

ipcMain.handle('state:get', async () => {
  await sweepLeftBets();
  return loadFullState();
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('settings:save', async (_event, settings) => {
  const appState = await cloud.fetchAppState();
  await cloud.updateAppState({ settings: { ...appState.settings, ...settings } });
  return loadFullState();
});

function createBetRecord(bet) {
  return {
    id: `bet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    placedAt: new Date().toISOString(),
    result: 'pending',
    sport: bet.sport ? String(bet.sport) : null,
    match: String(bet.match),
    market: String(bet.market),
    selection: bet.selection ? String(bet.selection) : null,
    book: bet.book ? String(bet.book) : null,
    odds: Number(bet.odds),
    stake: Number(bet.stake),
    type: bet.type === 'multi' || bet.type === 'prop' ? bet.type : 'single',
    legs: Array.isArray(bet.legs) ? bet.legs.map(String) : null,
    notes: bet.notes ? String(bet.notes) : null,
    decision: null,
    decidedAt: null,
    auto: Boolean(bet.auto),
  };
}

// Builds and logs the multi Lab Tech picked on its own, when auto-log is on.
function buildAutoMultiRecord(suggestion, band, hypotheses) {
  const hypothesisIds = suggestion.legs.flatMap((leg) =>
    matchingHypothesisIds({ type: 'multi', sport: leg.sport, odds: suggestion.combined }, hypotheses),
  );
  const brainNote = hypothesisIds.length
    ? ` Brain: leans on hypothes${hypothesisIds.length > 1 ? 'es' : 'is'} ${[...new Set(hypothesisIds)].join(', ')}.`
    : '';
  return createBetRecord({
    sport: suggestion.legs[0].sport,
    match: suggestion.legs[0].match,
    market: 'Same-game multi',
    selection: suggestion.legs.map((leg) => leg.selection).join(' + '),
    book: suggestion.legs[0].book,
    odds: suggestion.combined,
    stake: DEFAULT_AUTO_STAKE,
    type: 'multi',
    legs: suggestion.legs.map((leg) => `${leg.selection} (${leg.market}) @ ${leg.odds.toFixed(2)}`),
    notes:
      `Auto-logged by Lab Tech — combined odds ${suggestion.combined.toFixed(2)} within your ` +
      `${band.minOdds.toFixed(2)}–${band.maxOdds.toFixed(2)} band, +${suggestion.valueScore.toFixed(1)}% combined value vs market.` +
      brainNote,
    auto: true,
  });
}

async function refreshBoardAndMaybeAutoLog() {
  const state = await loadFullState();
  const board = await fetchCandidates(state.settings);
  board.candidates = applySuppression(board.candidates, suppressed);

  const band = {
    minOdds: Number(state.settings.minOdds) || 1.7,
    maxOdds: Number(state.settings.maxOdds) || 2.5,
  };
  // Loaded fresh each refresh — cheap (a handful of small vault notes) and
  // means an edited hypothesis takes effect on the very next cycle.
  const hypotheses = loadHypotheses();
  // Multi legs come from the wider (lower-floor) pool, not board.candidates —
  // two picks each already >= minOdds would always multiply past maxOdds.
  const legPool = applySuppression(board.legs || [], suppressed);
  const suggestion = suggestMulti(legPool, { ...band, model: state.model, hypotheses });
  board.suggestion = suggestion;
  delete board.legs;
  board.autoLogQualifyingMultis = Boolean(state.settings.autoLogQualifyingMultis);

  if (
    suggestion &&
    !suggestion.single &&
    state.settings.autoLogQualifyingMultis &&
    !isDuplicateMulti(state.bets, suggestion)
  ) {
    const record = buildAutoMultiRecord(suggestion, band, hypotheses);
    await cloud.insertBet(record);
    suppressSimilar(suppressed, suggestion.legs[0].match);
    board.autoLogged = record;
  }

  return board;
}

ipcMain.handle('odds:refresh', () => refreshBoardAndMaybeAutoLog());

ipcMain.handle('bet:add', async (_event, bet) => {
  await cloud.insertBet(createBetRecord(bet));
  return loadFullState();
});

ipcMain.handle('bet:decide', async (_event, { id, decision, match }) => {
  if (decision === 'taking' || decision === 'leaving' || decision === null) {
    await cloud.updateBet(id, { decision, decidedAt: decision ? new Date().toISOString() : null });
    if ((decision === 'taking' || decision === 'leaving') && match) {
      // Once you've made the call on a match, other picks from that same
      // match are noise for a bit — hide them instead of re-surfacing.
      suppressSimilar(suppressed, match);
    }
    await sweepLeftBets();
  }
  return loadFullState();
});

ipcMain.handle('bet:delete', async (_event, id) => {
  await cloud.deleteBetRow(id);
  return loadFullState();
});

ipcMain.handle('bet:settle', async (_event, { id, result }) => {
  if (result === 'win' || result === 'loss') {
    await cloud.updateBet(id, { result, settledAt: new Date().toISOString() });
  }
  return loadFullState();
});

ipcMain.handle('discord:post', async (_event, candidate) => {
  const appState = await cloud.fetchAppState();
  const webhook = appState.settings.discordWebhook;
  if (!webhook) {
    return { ok: false, error: 'No Discord webhook set — add it in Settings.' };
  }
  const lines = [
    `**Lab Tech pick — ${candidate.sport}**`,
    `${candidate.match} · ${candidate.market}`,
    `**${candidate.selection}** @ **${candidate.bestOdds.toFixed(2)}** (${candidate.bestBook})`,
    candidate.nextBest ? `Next best: ${candidate.nextBest}` : null,
    `Market median ${candidate.medianOdds.toFixed(2)} · ${candidate.valuePct > 0 ? '+' : ''}${candidate.valuePct}% vs market · ${candidate.booksCompared} books compared`,
    candidate.sample ? '_(sample data — no API key configured)_' : null,
  ].filter(Boolean);
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') }),
    });
    if (!res.ok) return { ok: false, error: `Discord responded ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    backgroundColor: '#101317',
    title: 'Lab Tech',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  // Live push whenever either install changes the shared bets/settings.
  cloud.subscribe(() => broadcastState());

  // Checked well inside the 5-minute "leaving" window so removal feels prompt.
  setInterval(async () => {
    if (await sweepLeftBets()) broadcastState();
  }, 15000);

  // Runs the odds board + suggestion + auto-log on its own, so Lab Tech
  // keeps working (and keeps feeding the model) without anyone watching.
  setInterval(async () => {
    if (!mainWindow) return;
    try {
      const board = await refreshBoardAndMaybeAutoLog();
      mainWindow.webContents.send('board:auto-refresh', board);
    } catch (err) {
      console.error('Background odds refresh failed:', err.message);
    }
  }, AUTO_REFRESH_MS);

  // `npm start -- --smoke` verifies the app boots, then exits.
  if (process.argv.includes('--smoke')) {
    console.log('SMOKE_OK');
    setTimeout(() => app.quit(), 1500);
  } else if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('Update check failed:', err.message);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
