const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { autoUpdater } = require('electron-updater');
const { fetchCandidates } = require('./engine/odds');
const {
  suppressSimilar,
  applySuppression,
  pruneLeftBets,
  suggestMulti,
  isDuplicateMulti,
} = require('./engine/similar');
const { learnFromSettledBet } = require('./engine/learning');

const DEFAULT_AUTO_STAKE = 10;
// ~96 refreshes/day so a month of unattended running (5 sports, 1 credit
// each) costs about 14,400 Odds API credits — inside the $30/mo 20K plan
// with room to spare. Free while running on sample data (no network call).
const AUTO_REFRESH_MS = 15 * 60 * 1000;

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const DEFAULT_STATE = {
  startingBankroll: 1000,
  bankroll: 1000,
  bets: [],
  suppressed: {},
  settings: {
    oddsApiKey: '',
    discordWebhook: '',
    minOdds: 1.7,
    maxOdds: 2.5,
    // Off by default — during the trial phase, qualifying multis wait for a
    // manual "Use suggested multi" click. Flip on once you trust the calls.
    autoLogQualifyingMultis: false,
  },
  model: {
    version: 0,
    updatedAt: null,
    factors: {},
    note: 'No settled bets yet — the model learns win rate and ROI per odds/sport/type bucket as bets settle.',
  },
};

function statePath() {
  return path.join(app.getPath('userData'), 'labtech-state.json');
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    const merged = {
      ...DEFAULT_STATE,
      ...raw,
      settings: { ...DEFAULT_STATE.settings, ...raw.settings },
      model: { ...DEFAULT_STATE.model, ...raw.model },
    };
    // Older saves had model.factors as an array placeholder — reset to the
    // bucketed object shape the learning loop uses.
    if (!merged.model.factors || Array.isArray(merged.model.factors)) {
      merged.model.factors = {};
    }
    return merged;
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

let state;
let mainWindow;

function sweepLeftBets() {
  if (!state) return;
  const before = state.bets.length;
  state.bets = pruneLeftBets(state.bets);
  if (state.bets.length !== before) {
    saveState(state);
    mainWindow?.webContents.send('bets:pruned', state);
  }
}

ipcMain.handle('state:get', () => {
  sweepLeftBets();
  return state;
});

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('settings:save', (_event, settings) => {
  state.settings = { ...state.settings, ...settings };
  saveState(state);
  return state;
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
function autoLogMulti(suggestion, band) {
  const record = createBetRecord({
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
      `${band.minOdds.toFixed(2)}–${band.maxOdds.toFixed(2)} band, +${suggestion.valueScore.toFixed(1)}% combined value vs market.`,
    auto: true,
  });
  state.bets.unshift(record);
  return record;
}

async function refreshBoardAndMaybeAutoLog() {
  const board = await fetchCandidates(state.settings);
  board.candidates = applySuppression(board.candidates, state.suppressed);

  const band = {
    minOdds: Number(state.settings.minOdds) || 1.7,
    maxOdds: Number(state.settings.maxOdds) || 2.5,
  };
  // Multi legs come from the wider (lower-floor) pool, not board.candidates —
  // two picks each already >= minOdds would always multiply past maxOdds.
  const legPool = applySuppression(board.legs || [], state.suppressed);
  const suggestion = suggestMulti(legPool, { ...band, model: state.model });
  board.suggestion = suggestion;
  delete board.legs;
  board.autoLogQualifyingMultis = Boolean(state.settings.autoLogQualifyingMultis);

  if (
    suggestion &&
    !suggestion.single &&
    state.settings.autoLogQualifyingMultis &&
    !isDuplicateMulti(state.bets, suggestion)
  ) {
    board.autoLogged = autoLogMulti(suggestion, band);
    suppressSimilar(state.suppressed, suggestion.legs[0].match);
    saveState(state);
  }

  return board;
}

ipcMain.handle('odds:refresh', () => refreshBoardAndMaybeAutoLog());

ipcMain.handle('bet:add', (_event, bet) => {
  state.bets.unshift(createBetRecord(bet));
  saveState(state);
  return state;
});

ipcMain.handle('bet:decide', (_event, { id, decision }) => {
  const bet = state.bets.find((b) => b.id === id);
  if (bet && (decision === 'taking' || decision === 'leaving' || decision === null)) {
    bet.decision = decision;
    bet.decidedAt = decision ? new Date().toISOString() : null;
    if (decision === 'taking' || decision === 'leaving') {
      // Once you've made the call on a match, other picks from that same
      // match are noise for a bit — hide them instead of re-surfacing.
      suppressSimilar(state.suppressed, bet.match);
    }
    sweepLeftBets();
    saveState(state);
  }
  return state;
});

ipcMain.handle('bet:delete', (_event, id) => {
  state.bets = state.bets.filter((b) => b.id !== id);
  saveState(state);
  return state;
});

ipcMain.handle('bet:settle', (_event, { id, result }) => {
  const bet = state.bets.find((b) => b.id === id && b.result === 'pending');
  if (bet && (result === 'win' || result === 'loss')) {
    bet.result = result;
    bet.settledAt = new Date().toISOString();
    if (result === 'win') {
      state.bankroll += bet.stake * (bet.odds - 1);
    } else {
      state.bankroll -= bet.stake;
    }
    state.bankroll = Math.round(state.bankroll * 100) / 100;
    state.model = learnFromSettledBet(state.model, bet);
    saveState(state);
  }
  return state;
});

ipcMain.handle('discord:post', async (_event, candidate) => {
  const webhook = state.settings.discordWebhook;
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
  state = loadState();
  createWindow();

  // Checked well inside the 5-minute "leaving" window so removal feels prompt.
  setInterval(sweepLeftBets, 15000);

  // Runs the odds board + suggestion + auto-log on its own, so Lab Tech
  // keeps working (and keeps feeding the model) without anyone watching.
  setInterval(async () => {
    if (!state || !mainWindow) return;
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
