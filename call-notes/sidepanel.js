/**
 * Call Notes: side panel logic.
 *
 * Sections in this file:
 *   1. Constants and small helpers
 *   2. Storage (chrome.storage.local only, no network)
 *   3. Meeting detection from the tab URL
 *   4. Markdown rendering (small, safe, offline)
 *   5. App state
 *   6. Header: call context, naming, text size
 *   7. Timer
 *   8. Notes editor + autosave
 *   9. Prep sets and cards
 *  10. Ask checklist ("questions to ask them")
 *  11. History and export
 *  12. Tabs, live updates, startup
 *
 * Storage layout (chrome.storage.local):
 *   note:<id>   one record per note. id is "general", "meet:<code>",
 *               "teams:<code>" or "<site>:named:<slug>" for a call you named.
 *   prep:sets   array of prep sets: { id, name, cards[], questions[] }
 *   settings    { lastSetId, textSize, oneAtATime }
 */

'use strict';

/* =====================================================================
 * 1. Constants and small helpers
 * ===================================================================== */

const SITES = {
  meet: { label: 'Google Meet', short: 'Meet' },
  teams: { label: 'Microsoft Teams', short: 'Teams' },
};

const GENERAL_ID = 'general';
const NOTE_PREFIX = 'note:';
const SETS_KEY = 'prep:sets';
const SETTINGS_KEY = 'settings';

const AUTOSAVE_INTERVAL_MS = 3000; // save at least this often while typing
const AUTOSAVE_DEBOUNCE_MS = 1000; // ...and this long after you stop typing

const TEAMS_HOSTS = ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'];

const TEXT_SIZES = ['s', 'm', 'l', 'xl'];

const DEFAULT_SETTINGS = {
  lastSetId: null,
  textSize: 'm',
  oneAtATime: false,
};

/** Shorthand for getElementById. */
const $ = (id) => document.getElementById(id);

/**
 * Tiny DOM builder. Props: class, text, dataset, on<event>, booleans set as
 * properties (checked, hidden, disabled), everything else as attributes.
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else if (typeof value === 'boolean') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child != null) node.append(child);
  }
  return node;
}

function uid() {
  return crypto.randomUUID();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function slugify(text) {
  return text.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'call';
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

function formatDateTime(ms) {
  return ms ? dateTimeFormat.format(new Date(ms)) : '';
}

/** YYYY-MM-DD in local time, for file names. */
function isoDate(ms) {
  const d = new Date(ms || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Short toast message at the bottom of the panel. */
let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 1800);
}

/**
 * Two-click confirmation for destructive buttons (native confirm() dialogs
 * are not reliable in the side panel). First click arms, second click runs.
 */
function confirmClick(button, action, armedLabel = 'Confirm?') {
  if (button.dataset.armed) {
    delete button.dataset.armed;
    action();
    return;
  }
  const original = button.textContent;
  button.dataset.armed = '1';
  button.textContent = armedLabel;
  button.classList.add('armed');
  setTimeout(() => {
    if (!button.isConnected) return;
    delete button.dataset.armed;
    button.textContent = original;
    button.classList.remove('armed');
  }, 3000);
}

/* =====================================================================
 * 2. Storage
 * ===================================================================== */

const store = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  },
  set(key, value) {
    return chrome.storage.local.set({ [key]: value });
  },
  remove(key) {
    return chrome.storage.local.remove(key);
  },
  getAll() {
    return chrome.storage.local.get(null);
  },
};

/* =====================================================================
 * 3. Meeting detection
 * ===================================================================== */

/** decodeURIComponent that never throws, applied twice for double-encoded Teams links. */
function safeDecode(text) {
  let out = text;
  for (let i = 0; i < 2; i++) {
    try {
      out = decodeURIComponent(out);
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Work out which call site and meeting code a URL belongs to.
 * Returns { site: 'meet' | 'teams' | null, code: string | null }.
 *
 * Google Meet:  https://meet.google.com/abc-defg-hij
 * Teams links:  .../l/meetup-join/19:meeting_XXXX@thread.v2/0?context=...
 *               https://teams.microsoft.com/meet/1234567890123?p=...
 *               https://teams.live.com/meet/9876543210987?p=...
 *               (the same formats on teams.cloud.microsoft)
 */
function parseCallUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { site: null, code: null };
  }

  if (parsed.hostname === 'meet.google.com') {
    const match = parsed.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/i);
    return { site: 'meet', code: match ? match[1].toLowerCase() : null };
  }

  if (TEAMS_HOSTS.includes(parsed.hostname)) {
    const full = safeDecode(parsed.href);
    let match = full.match(/19:meeting_([A-Za-z0-9_-]+)@thread\.v2/i);
    if (match) return { site: 'teams', code: `meeting_${match[1]}` };
    match = full.match(/\/meet\/(\d{6,})/);
    if (match) return { site: 'teams', code: match[1] };
    match = full.match(/meetup-join\/(19:[A-Za-z0-9_.-]+@thread\.[a-z0-9]+)/i);
    if (match) return { site: 'teams', code: match[1] };
    return { site: 'teams', code: null };
  }

  return { site: null, code: null };
}

/** Build a call descriptor. `code` may be a real meeting code or "named:<slug>". */
function makeCall(site, code, label = '') {
  return { id: `${site}:${code}`, site, code, label };
}

/** Readable form of a meeting code (long Teams thread ids are shortened). */
function displayCode(code) {
  if (!code) return '';
  if (code.startsWith('named:')) return code.slice(6);
  if (code.startsWith('meeting_')) code = code.slice(8); // Teams thread ids
  return code.length > 20 ? `${code.slice(0, 18)}…` : code;
}

/** Title shown for a note in the header, history and exports. */
function recordTitle(rec) {
  if (rec.id === GENERAL_ID) return 'General notes';
  if (rec.label) return rec.label;
  const site = SITES[rec.site]?.short || 'Call';
  return `${site} ${displayCode(rec.code)}`;
}

/* =====================================================================
 * 4. Markdown rendering
 *    Escapes all HTML first, then adds a small set of tags. Images are
 *    shown as text (never loaded) so nothing touches the network.
 * ===================================================================== */

function renderInline(text) {
  let s = escapeHtml(text);

  // Protect inline code from further formatting.
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '[image: $1]')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>');

  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

/** Nested <ul>/<ol> from a run of list lines, using indentation for nesting. */
function renderList(items) {
  let out = '';
  const stack = [];
  for (const item of items) {
    while (stack.length && item.indent < stack[stack.length - 1].indent) {
      out += `</li></${stack.pop().tag}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || item.indent > top.indent) {
      const tag = item.ordered ? 'ol' : 'ul';
      stack.push({ indent: item.indent, tag });
      out += `<${tag}>`;
    } else {
      out += '</li>';
    }
    const task = item.text.match(/^\[([ xX])\]\s+(.*)$/);
    if (task) {
      const checked = task[1] !== ' ' ? ' checked' : '';
      out += `<li class="task"><input type="checkbox" disabled${checked}>${renderInline(task[2])}`;
    } else {
      out += `<li>${renderInline(item.text)}`;
    }
  }
  while (stack.length) out += `</li></${stack.pop().tag}>`;
  return out;
}

function renderMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const listRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  let html = '';
  let paragraph = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${paragraph.map(renderInline).join('<br>')}</p>`;
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    let match;

    if (/^\s*```/.test(line)) { // fenced code block
      flushParagraph();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushParagraph();
      i++;
      continue;
    }
    if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushParagraph();
      const level = match[1].length;
      html += `<h${level}>${renderInline(match[2])}</h${level}>`;
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      html += '<hr>';
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      }
      html += `<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`;
      continue;
    }
    if (listRe.test(line)) {
      flushParagraph();
      const items = [];
      while (i < lines.length && (match = lines[i].match(listRe))) {
        items.push({
          indent: match[1].replace(/\t/g, '    ').length,
          ordered: /\d/.test(match[2]),
          text: match[3],
        });
        i++;
      }
      html += renderList(items);
      continue;
    }
    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return html;
}

/* =====================================================================
 * 5. App state
 * ===================================================================== */

const state = {
  tabId: null,          // the tab this panel belongs to
  site: null,           // 'meet' | 'teams' | null for the tab's current URL
  lastDetectedCode: null,
  call: null,           // current call descriptor, or null when no meeting detected
  ctx: null,            // record for the current call (or General): holds ticks + set choice
  scope: 'general',     // notes editor shows 'call' or 'general'
  viewingId: null,      // id of a past note opened from History
  note: null,           // record currently in the editor
  dirty: false,         // editor has unsaved changes
  mode: 'edit',         // 'edit' | 'preview'
  sets: [],
  settings: { ...DEFAULT_SETTINGS },
  expanded: new Set(),  // ids of open prep cards
  editingCardId: null,
  setFormMode: null,    // 'new' | 'rename' | null
};

/** In-memory copies of note records, keyed by id. */
const records = new Map();

function blankRecord(id, call) {
  return {
    id,
    site: call ? call.site : null,
    code: call ? call.code : null,
    label: call ? call.label : '',
    content: '',
    ticks: {},       // { [setId]: [questionId, ...] }
    prepSetId: null, // prep set chosen for this call
    createdAt: null,
    updatedAt: null,
  };
}

async function loadRecord(id, call = null) {
  if (records.has(id)) return records.get(id);
  const saved = await store.get(NOTE_PREFIX + id);
  const rec = Object.assign(blankRecord(id, call), saved || {});
  rec.ticks = rec.ticks || {};
  records.set(id, rec);
  return rec;
}

/** Write a record. If it is the one in the editor, include the latest text. */
async function persistRecord(rec) {
  if (rec === state.note) {
    rec.content = $('note-editor').value;
    state.dirty = false;
  }
  const now = Date.now();
  if (!rec.createdAt) rec.createdAt = now;
  rec.updatedAt = now;
  await store.set(NOTE_PREFIX + rec.id, rec);
}

function hasTicks(rec) {
  return Object.values(rec.ticks || {}).some((list) => list.length > 0);
}

async function saveSettings() {
  await store.set(SETTINGS_KEY, state.settings);
}

/* =====================================================================
 * 6. Header: call context, naming, text size
 * ===================================================================== */

function renderContext() {
  const badge = $('site-badge');
  const label = $('call-label');
  const nameBtn = $('name-call-btn');

  badge.textContent = state.site ? SITES[state.site].short : 'Notes';

  if (state.call) {
    label.textContent = state.call.label || displayCode(state.call.code);
    label.title = state.call.code.startsWith('named:') ? state.call.label : state.call.code;
    nameBtn.textContent = 'Rename';
  } else {
    label.textContent = state.site ? 'No meeting code yet' : 'General';
    label.title = state.site
      ? 'Join a meeting, or name this call to keep separate notes'
      : '';
    nameBtn.textContent = 'Name this call';
  }
  nameBtn.hidden = !state.site;

  // Notes scope toggle.
  const callBtn = $('scope-call');
  callBtn.disabled = !state.call;
  callBtn.title = state.call ? '' : 'No meeting detected in this tab';
  callBtn.setAttribute('aria-pressed', String(state.scope === 'call'));
  $('scope-general').setAttribute('aria-pressed', String(state.scope === 'general'));
}

function openNameForm() {
  const form = $('name-call-form');
  const input = $('name-call-input');
  input.value = state.call?.label || '';
  form.hidden = false;
  input.focus();
}

async function submitNameForm(event) {
  event.preventDefault();
  const name = $('name-call-input').value.trim();
  $('name-call-form').hidden = true;
  if (!name) return;

  if (state.call) {
    // Label an existing call (detected code or previously named).
    state.call.label = name;
    state.ctx.label = name;
    await persistRecord(state.ctx);
    renderContext();
    renderNotesBanner();
  } else if (state.site) {
    // No code in the URL: the name becomes the key, so the same name
    // brings back the same notes later.
    await switchCall(makeCall(state.site, `named:${slugify(name)}`, name));
    if (state.ctx.label !== name) {
      state.ctx.label = name;
      if (state.ctx.createdAt) await persistRecord(state.ctx);
    }
  }
}

function applyTextSize() {
  document.documentElement.dataset.size = state.settings.textSize;
}

function changeTextSize(step) {
  const index = TEXT_SIZES.indexOf(state.settings.textSize);
  const next = TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, index + step))];
  if (next === state.settings.textSize) return;
  state.settings.textSize = next;
  applyTextSize();
  saveSettings();
}

/* =====================================================================
 * 7. Timer: elapsed time since the panel opened, with pause and reset.
 *    Kept in memory only; it restarts when the panel is reopened.
 * ===================================================================== */

const timer = {
  running: true,
  startedAt: Date.now(),
  accumulated: 0,

  elapsed() {
    return this.accumulated + (this.running ? Date.now() - this.startedAt : 0);
  },
  toggle() {
    if (this.running) {
      this.accumulated = this.elapsed();
      this.running = false;
    } else {
      this.startedAt = Date.now();
      this.running = true;
    }
    renderTimer();
  },
  reset() {
    this.accumulated = 0;
    this.startedAt = Date.now();
    renderTimer();
  },
};

function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function renderTimer() {
  const display = $('timer-display');
  display.textContent = formatElapsed(timer.elapsed());
  display.classList.toggle('paused', !timer.running);
  $('timer-toggle').textContent = timer.running ? 'Pause' : 'Start';
}

/* =====================================================================
 * 8. Notes editor + autosave
 * ===================================================================== */

function activeNoteId() {
  if (state.viewingId) return state.viewingId;
  if (state.scope === 'call' && state.call) return state.call.id;
  return GENERAL_ID;
}

function setSaveStatus(kind) {
  const status = $('save-status');
  if (kind === 'saving') status.textContent = 'Saving…';
  else if (kind === 'unsaved') status.textContent = 'Unsaved changes';
  else if (kind === 'error') status.textContent = 'Could not save. Retrying…';
  else if (state.note?.updatedAt) status.textContent = `Saved ${timeFormat.format(new Date(state.note.updatedAt))}`;
  else status.textContent = 'Nothing saved yet';
}

/** Save the editor if it has changes. Safe to call often. */
async function saveNote() {
  if (!state.dirty || !state.note) return;
  setSaveStatus('saving');
  try {
    await persistRecord(state.note);
    setSaveStatus('saved');
  } catch (err) {
    console.error('Call Notes: save failed', err);
    state.dirty = true;
    setSaveStatus('error');
  }
}

let debounceTimer = null;
function onEditorInput() {
  state.dirty = true;
  setSaveStatus('unsaved');
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(saveNote, AUTOSAVE_DEBOUNCE_MS);
  if (state.mode === 'preview') renderPreview();
}

/** Load whichever note should be in the editor (call, General, or a past note). */
async function showNote() {
  await saveNote();
  const id = activeNoteId();
  const call = state.call && id === state.call.id ? state.call : null;
  const rec = await loadRecord(id, call);
  state.note = rec;

  const editor = $('note-editor');
  editor.value = rec.content || '';
  editor.disabled = false;
  state.dirty = false;

  renderContext();
  renderNotesBanner();
  renderPreview();
  setSaveStatus('saved');
}

function renderNotesBanner() {
  const banner = $('viewing-banner');
  if (!state.viewingId || !state.note) {
    banner.hidden = true;
    return;
  }
  const when = formatDateTime(state.note.createdAt);
  $('viewing-text').textContent = `Viewing: ${recordTitle(state.note)}${when ? ` · ${when}` : ''}`;
  banner.hidden = false;
}

function setMode(mode) {
  state.mode = mode;
  $('mode-edit').setAttribute('aria-pressed', String(mode === 'edit'));
  $('mode-preview').setAttribute('aria-pressed', String(mode === 'preview'));
  $('note-editor').hidden = mode !== 'edit';
  $('note-preview').hidden = mode !== 'preview';
  renderPreview();
  if (mode === 'edit') $('note-editor').focus();
}

function renderPreview() {
  if (state.mode !== 'preview') return;
  const text = $('note-editor').value;
  $('note-preview').innerHTML = text.trim()
    ? renderMarkdown(text)
    : '<p class="muted">Nothing to preview yet.</p>';
}

async function setScope(scope) {
  if (scope === 'call' && !state.call) return;
  state.scope = scope;
  state.viewingId = null;
  await showNote();
}

/* =====================================================================
 * 9. Prep sets and cards
 * ===================================================================== */

function newSet(name) {
  return { id: uid(), name, cards: [], questions: [] };
}

async function saveSets() {
  await store.set(SETS_KEY, state.sets);
}

/** The set picked for the current call, falling back to the last one used. */
function activeSet() {
  const wanted = state.ctx?.prepSetId || state.settings.lastSetId;
  return state.sets.find((s) => s.id === wanted) || state.sets[0];
}

async function selectSet(setId) {
  state.settings.lastSetId = setId;
  saveSettings();
  if (state.ctx) {
    state.ctx.prepSetId = setId;
    await persistRecord(state.ctx);
  }
  state.expanded.clear();
  state.editingCardId = null;
  renderPrep();
  renderAsk();
}

function renderSetSelects() {
  const current = activeSet();
  for (const id of ['prep-set-select', 'ask-set-select']) {
    const select = $(id);
    select.replaceChildren(...state.sets.map((set) => el('option', {
      value: set.id,
      text: `${set.name} (${set.cards.length} cards, ${set.questions.length} questions)`,
    })));
    select.value = current.id;
  }
}

function openSetForm(mode) {
  state.setFormMode = mode;
  const input = $('set-name-input');
  input.value = mode === 'rename' ? activeSet().name : '';
  $('set-name-form').hidden = false;
  input.focus();
}

async function submitSetForm(event) {
  event.preventDefault();
  const name = $('set-name-input').value.trim();
  $('set-name-form').hidden = true;
  if (!name) return;
  if (state.setFormMode === 'rename') {
    activeSet().name = name;
    await saveSets();
    renderPrep();
    renderAsk();
  } else {
    const set = newSet(name);
    state.sets.push(set);
    await saveSets();
    await selectSet(set.id);
  }
  state.setFormMode = null;
}

async function deleteActiveSet() {
  const set = activeSet();
  state.sets = state.sets.filter((s) => s.id !== set.id);
  if (!state.sets.length) state.sets.push(newSet('My prep'));
  await saveSets();
  await selectSet(state.sets[0].id);
  toast(`Deleted “${set.name}”`);
}

/**
 * Turn pasted text into cards. Supports three formats:
 *   Q: question / A: answer lines
 *   "## Question" headings with the answer underneath
 *   blocks separated by blank lines (first line is the question)
 */
function parseBulkCards(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const qRe = /^\s*Q\s*[:.)]\s*(.*)$/i;
  const aRe = /^\s*A\s*[:.)]\s*(.*)$/i;
  const headingRe = /^\s*#{1,6}\s+(.*)$/;
  const cards = [];
  let current = null;
  let field = null;

  if (lines.some((l) => qRe.test(l))) {
    for (const line of lines) {
      let m;
      if ((m = line.match(qRe))) {
        if (current) cards.push(current);
        current = { q: m[1], a: '' };
        field = 'q';
      } else if (current && field === 'q' && (m = line.match(aRe))) {
        current.a = m[1];
        field = 'a';
      } else if (current) {
        if (field === 'q') current.q += line.trim() ? ` ${line.trim()}` : '';
        else current.a += `\n${line}`;
      }
    }
    if (current) cards.push(current);
  } else if (lines.some((l) => headingRe.test(l))) {
    for (const line of lines) {
      const m = line.match(headingRe);
      if (m) {
        if (current) cards.push(current);
        current = { q: m[1], a: '' };
      } else if (current) {
        current.a += `\n${line}`;
      }
    }
    if (current) cards.push(current);
  } else {
    for (const block of text.split(/\n\s*\n/)) {
      const [first, ...rest] = block.trim().split('\n');
      if (first) cards.push({ q: first, a: rest.join('\n') });
    }
  }

  return cards
    .map((c) => ({ id: uid(), q: c.q.trim(), a: c.a.replace(/^\s*\n/, '').trimEnd() }))
    .filter((c) => c.q);
}

function toggleCard(cardId) {
  if (state.expanded.has(cardId)) {
    state.expanded.delete(cardId);
  } else {
    if (state.settings.oneAtATime) state.expanded.clear();
    state.expanded.add(cardId);
  }
  renderCards();
}

async function moveCard(cardId, delta) {
  const cards = activeSet().cards;
  const from = cards.findIndex((c) => c.id === cardId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= cards.length) return;
  [cards[from], cards[to]] = [cards[to], cards[from]];
  await saveSets();
  renderCards();
}

async function deleteCard(cardId) {
  const set = activeSet();
  set.cards = set.cards.filter((c) => c.id !== cardId);
  state.expanded.delete(cardId);
  await saveSets();
  renderPrep();
}

function cardEditForm(card) {
  const q = el('input', { type: 'text', value: card.q, 'aria-label': 'Question' });
  const a = el('textarea', { rows: '6', 'aria-label': 'Answer' });
  a.value = card.a;
  const save = async (event) => {
    event.preventDefault();
    if (!q.value.trim()) return;
    card.q = q.value.trim();
    card.a = a.value.trimEnd();
    state.editingCardId = null;
    await saveSets();
    renderCards();
  };
  return el('form', { class: 'card-edit stack', onsubmit: save }, [
    q, a,
    el('div', { class: 'btn-group' }, [
      el('button', { class: 'btn primary', type: 'submit', text: 'Save' }),
      el('button', {
        class: 'btn', type: 'button', text: 'Cancel',
        onclick: () => { state.editingCardId = null; renderCards(); },
      }),
    ]),
  ]);
}

function cardItem(card, index, total) {
  if (state.editingCardId === card.id) {
    return el('li', { class: 'card', dataset: { id: card.id } }, cardEditForm(card));
  }
  const open = state.expanded.has(card.id);
  const body = el('div', { class: 'card-body', hidden: !open });
  if (open) {
    const answer = el('div', { class: 'markdown answer' });
    answer.innerHTML = card.a.trim() ? renderMarkdown(card.a) : '<p class="muted">No answer yet.</p>';
    body.append(answer, el('div', { class: 'card-actions' }, [
      el('button', {
        class: 'icon-btn', type: 'button', text: '↑', title: 'Move up', 'aria-label': 'Move up',
        disabled: index === 0, onclick: () => moveCard(card.id, -1),
      }),
      el('button', {
        class: 'icon-btn', type: 'button', text: '↓', title: 'Move down', 'aria-label': 'Move down',
        disabled: index === total - 1, onclick: () => moveCard(card.id, 1),
      }),
      el('button', {
        class: 'icon-btn', type: 'button', text: 'Edit',
        onclick: () => { state.editingCardId = card.id; renderCards(); },
      }),
      el('button', {
        class: 'icon-btn', type: 'button', text: 'Delete',
        onclick: (e) => confirmClick(e.currentTarget, () => deleteCard(card.id), 'Delete?'),
      }),
    ]));
  }
  return el('li', { class: 'card', dataset: { id: card.id } }, [
    el('button', {
      class: 'card-head', type: 'button', 'aria-expanded': String(open),
      onclick: () => toggleCard(card.id),
    }, [el('span', { class: 'chev', text: '▸', 'aria-hidden': 'true' }), el('span', { text: card.q })]),
    body,
  ]);
}

function renderCards() {
  const set = activeSet();
  const filter = $('card-filter').value.trim().toLowerCase();
  const visible = filter
    ? set.cards.filter((c) => `${c.q}\n${c.a}`.toLowerCase().includes(filter))
    : set.cards;
  $('card-list').replaceChildren(...visible.map((c) => cardItem(c, set.cards.indexOf(c), set.cards.length)));
  const empty = $('cards-empty');
  empty.hidden = visible.length > 0;
  empty.textContent = set.cards.length
    ? 'No cards match your filter.'
    : 'No cards in this set yet. Add one below, or paste a batch.';
}

function renderPrep() {
  renderSetSelects();
  $('one-at-a-time').checked = state.settings.oneAtATime;
  renderCards();
}

async function addCard(event) {
  event.preventDefault();
  const q = $('card-q').value.trim();
  if (!q) return;
  const card = { id: uid(), q, a: $('card-a').value.trimEnd() };
  activeSet().cards.push(card);
  await saveSets();
  $('card-q').value = '';
  $('card-a').value = '';
  renderPrep();
  $('card-q').focus();
  toast('Card added');
}

async function importCards(event) {
  event.preventDefault();
  const cards = parseBulkCards($('bulk-text').value);
  if (!cards.length) {
    toast('No cards found in that text');
    return;
  }
  activeSet().cards.push(...cards);
  await saveSets();
  $('bulk-text').value = '';
  $('bulk-panel').open = false;
  renderPrep();
  toast(`Imported ${cards.length} card${cards.length === 1 ? '' : 's'}`);
}

/* =====================================================================
 * 10. Ask checklist
 *     Questions live in the prep set (so you can prepare them before the
 *     call). Ticks are saved per call, so each call starts unticked.
 * ===================================================================== */

function tickedSet(setId) {
  return new Set(state.ctx?.ticks?.[setId] || []);
}

async function toggleTick(questionId, checked) {
  const set = activeSet();
  const ticked = tickedSet(set.id);
  if (checked) ticked.add(questionId);
  else ticked.delete(questionId);
  state.ctx.ticks[set.id] = [...ticked];
  state.ctx.prepSetId = set.id;
  await persistRecord(state.ctx);
  renderAsk();
}

function renderAsk() {
  renderSetSelects();
  const set = activeSet();
  const ticked = tickedSet(set.id);
  const items = set.questions.map((q) => {
    const done = ticked.has(q.id);
    return el('li', { class: `ask-item${done ? ' done' : ''}` }, [
      el('label', {}, [
        el('input', {
          type: 'checkbox', checked: done,
          onchange: (e) => toggleTick(q.id, e.target.checked),
        }),
        el('span', { text: q.text }),
      ]),
      el('button', {
        class: 'icon-btn', type: 'button', text: '×', title: 'Remove question',
        'aria-label': `Remove question: ${q.text}`,
        onclick: (e) => confirmClick(e.currentTarget, () => removeQuestion(q.id), '×?'),
      }),
    ]);
  });
  $('ask-list').replaceChildren(...items);
  $('ask-empty').hidden = items.length > 0;

  const doneCount = set.questions.filter((q) => ticked.has(q.id)).length;
  $('ask-progress').textContent = set.questions.length
    ? `${doneCount} of ${set.questions.length} asked`
    : '';
  $('ask-scope').textContent = state.call
    ? `Ticks saved for ${state.call.label || displayCode(state.call.code)}`
    : 'Ticks saved in General (no meeting detected)';
}

async function addQuestion(event) {
  event.preventDefault();
  const input = $('ask-input');
  const text = input.value.trim();
  if (!text) return;
  activeSet().questions.push({ id: uid(), text });
  await saveSets();
  input.value = '';
  renderAsk();
  input.focus();
}

async function removeQuestion(questionId) {
  const set = activeSet();
  set.questions = set.questions.filter((q) => q.id !== questionId);
  await saveSets();
  renderAsk();
}

async function resetTicks() {
  const set = activeSet();
  if (!state.ctx.ticks[set.id]?.length) return;
  state.ctx.ticks[set.id] = [];
  await persistRecord(state.ctx);
  renderAsk();
}

/* =====================================================================
 * 11. History and export
 * ===================================================================== */

/** Question lists (with ticks) for the prep sets a note used. */
function questionSections(rec) {
  const ids = new Set([rec.prepSetId, ...Object.keys(rec.ticks || {})].filter(Boolean));
  const sections = [];
  for (const id of ids) {
    const set = state.sets.find((s) => s.id === id);
    if (!set || !set.questions.length) continue;
    const ticked = new Set(rec.ticks?.[id] || []);
    sections.push({ name: set.name, items: set.questions.map((q) => ({ text: q.text, done: ticked.has(q.id) })) });
  }
  return sections;
}

function metaLines(rec) {
  const lines = [];
  if (rec.site) lines.push(['Site', SITES[rec.site].label]);
  if (rec.code && !rec.code.startsWith('named:')) lines.push(['Meeting code', rec.code]);
  if (rec.createdAt) lines.push(['Date', formatDateTime(rec.createdAt)]);
  if (rec.updatedAt && rec.updatedAt !== rec.createdAt) lines.push(['Last edited', formatDateTime(rec.updatedAt)]);
  return lines;
}

function buildMarkdown(rec) {
  const parts = [`# ${recordTitle(rec)}`, ''];
  for (const [k, v] of metaLines(rec)) parts.push(`- **${k}:** ${v}`);
  parts.push('', rec.content.trim() || '_No notes._');
  for (const section of questionSections(rec)) {
    parts.push('', `## Questions to ask (${section.name})`, '');
    for (const item of section.items) parts.push(`- [${item.done ? 'x' : ' '}] ${item.text}`);
  }
  return `${parts.join('\n')}\n`;
}

function buildText(rec) {
  const title = recordTitle(rec);
  const parts = [title, '='.repeat(Math.min(title.length, 60))];
  for (const [k, v] of metaLines(rec)) parts.push(`${k}: ${v}`);
  parts.push('', rec.content.trim() || '(No notes.)');
  for (const section of questionSections(rec)) {
    parts.push('', `Questions to ask (${section.name})`);
    for (const item of section.items) parts.push(`[${item.done ? 'x' : ' '}] ${item.text}`);
  }
  return `${parts.join('\n')}\n`;
}

function fileName(rec, ext) {
  const name = rec.id === GENERAL_ID
    ? 'general'
    : `${rec.site || 'call'}_${slugify(rec.label || displayCode(rec.code) || 'call')}`;
  return `call-notes_${name}_${isoDate(rec.createdAt)}.${ext}`;
}

/** Save a text file through a temporary blob link (no downloads permission needed). */
function downloadFile(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for when the panel does not have focus.
    const area = el('textarea', { class: 'sr-only' });
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copied to clipboard');
}

async function exportRecord(rec, kind) {
  if (rec === state.note) await saveNote();
  if (kind === 'copy') return copyText(buildMarkdown(rec));
  if (kind === 'md') downloadFile(fileName(rec, 'md'), buildMarkdown(rec), 'text/markdown');
  else downloadFile(fileName(rec, 'txt'), buildText(rec), 'text/plain');
  toast('Exported');
}

/** Current editor note, with unsaved text included. */
function currentNoteForExport() {
  const rec = state.note;
  if (rec && state.dirty) rec.content = $('note-editor').value;
  return rec;
}

async function listHistory() {
  const all = await store.getAll();
  return Object.entries(all)
    .filter(([key, rec]) => key.startsWith(NOTE_PREFIX) && rec && rec.id !== GENERAL_ID)
    .map(([, rec]) => rec)
    .filter((rec) => (rec.content || '').trim() || hasTicks(rec))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function renderHistory() {
  await saveNote();
  const filter = $('history-filter').value.trim().toLowerCase();
  let notes = await listHistory();
  if (filter) {
    notes = notes.filter((r) => `${recordTitle(r)} ${r.code} ${r.content}`.toLowerCase().includes(filter));
  }

  const items = notes.map((saved) => {
    // Prefer the in-memory copy so exports include anything just typed.
    const rec = records.get(saved.id) || saved;
    const meta = [SITES[rec.site]?.label, rec.code && !rec.code.startsWith('named:') ? displayCode(rec.code) : null,
      formatDateTime(rec.createdAt)].filter(Boolean).join(' · ');
    const preview = (rec.content || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return el('li', { class: 'history-item' }, [
      el('div', { class: 'history-title', text: recordTitle(rec) }),
      el('div', { class: 'history-meta', text: meta }),
      el('div', { class: 'history-preview', text: preview || 'Checklist only' }),
      el('div', { class: 'btn-group' }, [
        el('button', { class: 'btn', type: 'button', text: 'Open', onclick: () => openPastNote(rec.id) }),
        el('button', { class: 'btn', type: 'button', text: 'Copy', onclick: () => exportRecord(rec, 'copy') }),
        el('button', { class: 'btn', type: 'button', text: '.md', onclick: () => exportRecord(rec, 'md') }),
        el('button', { class: 'btn', type: 'button', text: '.txt', onclick: () => exportRecord(rec, 'txt') }),
        el('button', {
          class: 'btn danger', type: 'button', text: 'Delete',
          onclick: (e) => confirmClick(e.currentTarget, () => deleteNote(rec.id), 'Delete?'),
        }),
      ]),
    ]);
  });

  $('history-list').replaceChildren(...items);
  const empty = $('history-empty');
  empty.hidden = items.length > 0;
  empty.textContent = filter ? 'No notes match your search.' : 'No saved call notes yet.';
}

async function openPastNote(id) {
  if (state.call && id === state.call.id) {
    // It's the call we're on: just show it normally.
    state.viewingId = null;
    state.scope = 'call';
  } else {
    state.viewingId = id;
  }
  switchTab('notes');
  await showNote();
}

async function deleteNote(id) {
  const wasInEditor = state.note?.id === id;
  if (wasInEditor) {
    clearTimeout(debounceTimer);
    state.dirty = false;
  }
  await store.remove(NOTE_PREFIX + id);
  records.delete(id);
  if (state.ctx?.id === id) state.ctx = await loadRecord(id, state.call);
  if (state.viewingId === id) state.viewingId = null;
  if (wasInEditor) await showNote();
  renderAsk();
  await renderHistory();
  toast('Note deleted');
}

/* =====================================================================
 * 12. Tabs, live updates, startup
 * ===================================================================== */

function switchTab(name) {
  for (const button of document.querySelectorAll('.tab')) {
    const selected = button.dataset.tab === name;
    button.setAttribute('aria-selected', String(selected));
    $(`tab-${button.dataset.tab}`).hidden = !selected;
  }
  if (name === 'history') renderHistory();
  if (name === 'prep') renderPrep();
  if (name === 'ask') renderAsk();
}

/** Point the panel at a different call (or at none). */
async function switchCall(call) {
  await saveNote();
  state.call = call;
  state.ctx = await loadRecord(call ? call.id : GENERAL_ID, call);
  if (call && state.ctx.label && !call.label) call.label = state.ctx.label;
  state.viewingId = null;
  state.scope = call ? 'call' : 'general';
  state.expanded.clear();
  await showNote();
  renderPrep();
  renderAsk();
}

/**
 * React to the tab's URL. A new meeting code switches notes; a URL without a
 * code keeps the current call (Teams often drops the id from the URL after
 * joining, and Meet briefly shows other pages).
 */
async function handleUrl(url) {
  const { site, code } = parseCallUrl(url || '');
  state.site = site;
  if (site && code && code !== state.lastDetectedCode) {
    state.lastDetectedCode = code;
    await switchCall(makeCall(site, code));
  } else {
    renderContext();
  }
}

/** Keep in sync with edits made in another panel (e.g. a second call tab). */
function onStorageChanged(changes, area) {
  if (area !== 'local') return;

  if (changes[SETS_KEY]?.newValue && !state.editingCardId && $('set-name-form').hidden) {
    const incoming = changes[SETS_KEY].newValue;
    if (JSON.stringify(incoming) !== JSON.stringify(state.sets)) {
      state.sets = incoming.length ? incoming : [newSet('My prep')];
      renderPrep();
      renderAsk();
    }
  }

  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith(NOTE_PREFIX)) continue;
    const id = key.slice(NOTE_PREFIX.length);
    const cached = records.get(id);
    if (!cached) continue;
    const isEditorNote = cached === state.note;
    if (isEditorNote && state.dirty) continue; // never overwrite unsaved typing
    if (change.newValue) {
      if (change.newValue.updatedAt === cached.updatedAt) continue; // our own write
      Object.assign(cached, change.newValue);
    } else {
      Object.assign(cached, blankRecord(id, state.call?.id === id ? state.call : null));
    }
    if (isEditorNote && $('note-editor').value !== cached.content) {
      $('note-editor').value = cached.content;
      renderPreview();
      setSaveStatus('saved');
    }
    if (cached === state.ctx) renderAsk();
  }
}

/** Find the tab this panel belongs to (the active tab of the panel's window). */
async function findOwnTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function bindEvents() {
  // Header
  $('name-call-btn').addEventListener('click', openNameForm);
  $('name-call-form').addEventListener('submit', submitNameForm);
  $('name-call-cancel').addEventListener('click', () => { $('name-call-form').hidden = true; });
  $('text-smaller').addEventListener('click', () => changeTextSize(-1));
  $('text-larger').addEventListener('click', () => changeTextSize(1));
  $('timer-toggle').addEventListener('click', () => timer.toggle());
  $('timer-reset').addEventListener('click', () => timer.reset());

  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  }

  // Notes
  const editor = $('note-editor');
  editor.addEventListener('input', onEditorInput);
  editor.addEventListener('blur', saveNote);
  $('scope-call').addEventListener('click', () => setScope('call'));
  $('scope-general').addEventListener('click', () => setScope('general'));
  $('mode-edit').addEventListener('click', () => setMode('edit'));
  $('mode-preview').addEventListener('click', () => setMode('preview'));
  $('viewing-back').addEventListener('click', () => setScope(state.call ? 'call' : 'general'));
  $('note-copy').addEventListener('click', () => exportRecord(currentNoteForExport(), 'copy'));
  $('note-md').addEventListener('click', () => exportRecord(currentNoteForExport(), 'md'));
  $('note-txt').addEventListener('click', () => exportRecord(currentNoteForExport(), 'txt'));

  // Prep
  $('prep-set-select').addEventListener('change', (e) => selectSet(e.target.value));
  $('set-new').addEventListener('click', () => openSetForm('new'));
  $('set-rename').addEventListener('click', () => openSetForm('rename'));
  $('set-delete').addEventListener('click', (e) => confirmClick(e.currentTarget, deleteActiveSet, 'Delete set?'));
  $('set-name-form').addEventListener('submit', submitSetForm);
  $('set-name-cancel').addEventListener('click', () => { $('set-name-form').hidden = true; });
  $('card-filter').addEventListener('input', renderCards);
  $('cards-expand').addEventListener('click', () => {
    for (const card of activeSet().cards) state.expanded.add(card.id);
    renderCards();
  });
  $('cards-collapse').addEventListener('click', () => { state.expanded.clear(); renderCards(); });
  $('one-at-a-time').addEventListener('change', (e) => {
    state.settings.oneAtATime = e.target.checked;
    saveSettings();
  });
  $('card-form').addEventListener('submit', addCard);
  $('bulk-form').addEventListener('submit', importCards);

  // Ask
  $('ask-set-select').addEventListener('change', (e) => selectSet(e.target.value));
  $('ask-form').addEventListener('submit', addQuestion);
  $('ask-reset').addEventListener('click', resetTicks);

  // History
  $('history-filter').addEventListener('input', renderHistory);

  // Ctrl/Cmd+S saves immediately.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNote();
    }
  });

  // Save when the panel is hidden or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNote();
  });
  window.addEventListener('pagehide', saveNote);

  chrome.storage.onChanged.addListener(onStorageChanged);

  // Follow URL changes in our own tab (joining a meeting, switching meetings).
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.tabId && changeInfo.url) handleUrl(changeInfo.url);
  });
}

async function init() {
  const [savedSettings, savedSets] = await Promise.all([store.get(SETTINGS_KEY), store.get(SETS_KEY)]);
  state.settings = { ...DEFAULT_SETTINGS, ...(savedSettings || {}) };
  state.sets = Array.isArray(savedSets) && savedSets.length ? savedSets : [newSet('My prep')];
  if (!savedSets?.length) await saveSets();
  applyTextSize();

  bindEvents();
  renderTimer();
  setInterval(renderTimer, 500);
  setInterval(saveNote, AUTOSAVE_INTERVAL_MS);

  const tab = await findOwnTab();
  state.tabId = tab?.id ?? null;
  state.ctx = await loadRecord(GENERAL_ID);
  await handleUrl(tab?.url);
  if (!state.call) await switchCall(null);

  // Always open on Notes: the most useful view when a call starts.
  switchTab('notes');
}

init();
