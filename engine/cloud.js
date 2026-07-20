// Shared cloud store — every Lab Tech install reads and writes the same
// Supabase project, so bets/bankroll/model are one live shared ledger
// instead of a separate file per machine. The key below is Supabase's
// "publishable" key: it's designed to ship inside distributed client apps
// (protected by row-level security policies, not secrecy) — never put the
// sb_secret_ key here.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://djqwbhuedzgjclxnvvvi.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_PRASdat61f82fmSTvAEcAQ_Pj7HKkcM';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

function rowToBet(row) {
  return {
    id: row.id,
    placedAt: row.placed_at,
    result: row.result,
    settledAt: row.settled_at,
    sport: row.sport,
    match: row.match,
    market: row.market,
    selection: row.selection,
    book: row.book,
    odds: Number(row.odds),
    stake: Number(row.stake),
    type: row.type,
    legs: row.legs,
    notes: row.notes,
    decision: row.decision,
    decidedAt: row.decided_at,
    auto: row.auto,
  };
}

function betToRow(bet) {
  return {
    id: bet.id,
    placed_at: bet.placedAt,
    result: bet.result,
    settled_at: bet.settledAt ?? null,
    sport: bet.sport ?? null,
    match: bet.match,
    market: bet.market,
    selection: bet.selection ?? null,
    book: bet.book ?? null,
    odds: bet.odds,
    stake: bet.stake,
    type: bet.type,
    legs: bet.legs ?? null,
    notes: bet.notes ?? null,
    decision: bet.decision ?? null,
    decided_at: bet.decidedAt ?? null,
    auto: Boolean(bet.auto),
  };
}

async function fetchBets() {
  const { data, error } = await supabase.from('bets').select('*').order('placed_at', { ascending: false });
  if (error) throw new Error(`Supabase fetchBets: ${error.message}`);
  return data.map(rowToBet);
}

async function insertBet(bet) {
  const { error } = await supabase.from('bets').insert(betToRow(bet));
  if (error) throw new Error(`Supabase insertBet: ${error.message}`);
}

async function updateBet(id, patch) {
  const row = {};
  if ('result' in patch) row.result = patch.result;
  if ('settledAt' in patch) row.settled_at = patch.settledAt;
  if ('decision' in patch) row.decision = patch.decision;
  if ('decidedAt' in patch) row.decided_at = patch.decidedAt;
  const { error } = await supabase.from('bets').update(row).eq('id', id);
  if (error) throw new Error(`Supabase updateBet: ${error.message}`);
}

async function deleteBetRow(id) {
  const { error } = await supabase.from('bets').delete().eq('id', id);
  if (error) throw new Error(`Supabase deleteBetRow: ${error.message}`);
}

async function fetchAppState() {
  const { data, error } = await supabase.from('app_state').select('*').eq('id', true).single();
  if (error) throw new Error(`Supabase fetchAppState: ${error.message}`);
  return { startingBankroll: Number(data.starting_bankroll), settings: data.settings || {} };
}

async function updateAppState(patch) {
  const row = {};
  if ('startingBankroll' in patch) row.starting_bankroll = patch.startingBankroll;
  if ('settings' in patch) row.settings = patch.settings;
  const { error } = await supabase.from('app_state').update(row).eq('id', true);
  if (error) throw new Error(`Supabase updateAppState: ${error.message}`);
}

// Fires on every change to the shared tables, from either install — lets
// main.js push a fresh state to its renderer whenever the other side moves.
function subscribe(onChange) {
  const channel = supabase
    .channel('lab-tech-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bets' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state' }, onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

module.exports = { fetchBets, insertBet, updateBet, deleteBetRow, fetchAppState, updateAppState, subscribe };
