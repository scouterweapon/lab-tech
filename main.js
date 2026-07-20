const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { autoUpdater } = require('electron-updater');
const { fetchCandidates } = require('./engine/odds');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const DEFAULT_STATE = {
  startingBankroll: 1000,
  bankroll: 1000,
  bets: [],
  settings: {
    oddsApiKey: '',
    discordWebhook: '',
    minOdds: 1.7,
    maxOdds: 2.5,
  },
  model: {
    version: 0,
    updatedAt: null,
    factors: [],
    note: 'Learning loop not implemented yet — every settled bet is recorded so the future model has history to learn from.',
  },
};

function statePath() {
  return path.join(app.getPath('userData'), 'labtech-state.json');
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    return {
      ...DEFAULT_STATE,
      ...raw,
      settings: { ...DEFAULT_STATE.settings, ...raw.settings },
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

let state;

ipcMain.handle('state:get', () => state);

ipcMain.handle('settings:save', (_event, settings) => {
  state.settings = { ...state.settings, ...settings };
  saveState(state);
  return state;
});

ipcMain.handle('odds:refresh', async () => {
  const board = await fetchCandidates(state.settings);
  return board;
});

ipcMain.handle('bet:add', (_event, bet) => {
  state.bets.unshift({
    id: `bet-${Date.now().toString(36)}`,
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
  });
  saveState(state);
  return state;
});

ipcMain.handle('bet:decide', (_event, { id, decision }) => {
  const bet = state.bets.find((b) => b.id === id);
  if (bet && (decision === 'taking' || decision === 'leaving' || decision === null)) {
    bet.decision = decision;
    saveState(state);
  }
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
}

app.whenReady().then(() => {
  state = loadState();
  createWindow();

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
