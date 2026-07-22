// Qualitative layer on top of engine/learning.js's numeric bucket model.
// Hypotheses live as markdown notes in a dedicated Obsidian vault (edited by
// Claude and the user, not by this app) — this module is read-only: it never
// writes to the vault, it just folds hypothesis confidence into scoring.
// Reading straight off disk (not the vault's Local REST API) means this
// works even when Obsidian itself isn't running.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const matter = require('gray-matter');
const { factorKeysFor } = require('./learning');

const VAULT_PATH = path.join(os.homedir(), 'Lab Tech Brain');
const HYPOTHESES_DIR = path.join(VAULT_PATH, 'Hypotheses');

// How much a single fully-confident, fully-matching hypothesis can move a
// score by. Kept small relative to learnedScore's ROI-fraction range so the
// brain nudges picks rather than overriding the numeric track record.
const MAX_ADJUSTMENT = 0.08;

function loadHypotheses(dir = HYPOTHESES_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return []; // vault/folder not present yet — brain contributes nothing
  }

  const hypotheses = [];
  for (const file of files) {
    if (!file.endsWith('.md') || file.toLowerCase() === 'readme.md') continue;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const { data } = matter(raw);
      if (!data.id || !data.status) continue;
      hypotheses.push({
        id: data.id,
        status: data.status,
        confidence: Math.max(0, Math.min(1, Number(data.confidence) || 0)),
        factorTags: Array.isArray(data.factor_tags) ? data.factor_tags.map(String) : [],
      });
    } catch {
      // A single malformed note shouldn't take the whole board down.
    }
  }
  return hypotheses;
}

// Active/confirmed hypotheses that share a factor tag with this bet nudge
// its score up by their confidence; rejected ones nudge it down — a
// rejected-but-matching hypothesis is a real, useful signal not to repeat
// whatever the market value% alone would have recommended.
function brainAdjustment(betLike, hypotheses) {
  if (!hypotheses.length) return 0;
  const keys = new Set(factorKeysFor(betLike));
  const matches = hypotheses.filter((h) => h.factorTags.some((tag) => keys.has(tag)));
  if (!matches.length) return 0;

  const total = matches.reduce((sum, h) => {
    if (h.status === 'active' || h.status === 'confirmed') return sum + h.confidence;
    if (h.status === 'rejected') return sum - h.confidence;
    return sum; // retired — ignored
  }, 0);

  return (total / matches.length) * MAX_ADJUSTMENT;
}

// Names the matching active/confirmed hypotheses so a log entry can cite
// which one nudged the pick — same "no black box" spirit as learning.js.
function matchingHypothesisIds(betLike, hypotheses) {
  const keys = new Set(factorKeysFor(betLike));
  return hypotheses
    .filter((h) => (h.status === 'active' || h.status === 'confirmed') && h.factorTags.some((tag) => keys.has(tag)))
    .map((h) => h.id);
}

module.exports = { VAULT_PATH, HYPOTHESES_DIR, loadHypotheses, brainAdjustment, matchingHypothesisIds };
