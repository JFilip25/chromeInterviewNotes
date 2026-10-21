// End-to-end test for the Call Notes extension in real Chromium (headless).
//
//   npm install && npx playwright install chromium
//   npm test                      (or: node tests/e2e.mjs)
//   SCREENSHOTS=1 npm test        also saves panel screenshots to tests/screenshots/
//
// Meet and Teams pages are faked with request routing, so no real call traffic
// happens. Chrome is launched twice with the same profile to check persistence.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '../call-notes');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'call-notes-e2e-'));
const SHOTS = process.env.SCREENSHOTS ? path.join(HERE, 'screenshots') : null;
const PORT = 9334;

const MEET_A = 'https://meet.google.com/abc-defg-hij';
const MEET_B = 'https://meet.google.com/xyz-abcd-efg';
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjE4ZTk2YmQtZGVm%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d';
const TEAMS_LIVE = 'https://teams.live.com/meet/9381234567890?p=abc';
const OTHER = 'https://example.com/';

let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, `--remote-debugging-port=${PORT}`],
  });
  await ctx.route(/https:\/\/(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|example\.com)\/.*/,
    (r) => r.fulfill({ contentType: 'text/html', body: '<title>fake call page</title><h1>call</h1>' }));
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  return { ctx, sw, extId, cdps: [] };
}

async function tabIdFor(sw, url) {
  return sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id, url);
}

/** Open the real side panel for a tab (needs a user gesture, so click a button in an extension page). */
async function openPanel(env, tabPage, url) {
  const tabId = await tabIdFor(env.sw, url);
  assert.ok(tabId, `tab for ${url}`);
  const helper = await env.ctx.newPage();
  await helper.goto(`chrome-extension://${env.extId}/sidepanel.html#helper`);
  await helper.evaluate((id) => {
    const b = document.createElement('button');
    b.id = 'opener';
    b.onclick = () => chrome.sidePanel.open({ tabId: id }).then(() => { b.dataset.ok = '1'; }, (e) => { b.dataset.err = e.message; });
    document.body.prepend(b);
  }, tabId);
  await helper.click('#opener');
  await helper.waitForFunction(() => document.getElementById('opener').dataset.ok || document.getElementById('opener').dataset.err);
  const err = await helper.evaluate(() => document.getElementById('opener').dataset.err);
  assert.equal(err, undefined, `sidePanel.open error: ${err}`);
  await helper.close();
  await tabPage.bringToFront();

  // Find the panel page through a fresh CDP connection (Playwright doesn't list side panels in the persistent context).
  for (let i = 0; i < 50; i++) {
    const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    env.cdps.push(cdp);
    for (const c of cdp.contexts()) {
      for (const p of c.pages()) {
        if (!p.url().endsWith('/sidepanel.html') || claimed.has(await targetId(p))) continue;
        const isTab = await p.evaluate(async () => !!(await chrome.tabs.getCurrent())).catch(() => true);
        if (!isTab) {
          claimed.add(await targetId(p));
          p.__errors = [];
          p.__requests = [];
          p.on('pageerror', (e) => p.__errors.push(String(e)));
          p.on('console', (m) => { if (m.type() === 'error') p.__errors.push(m.text()); });
          p.on('request', (r) => p.__requests.push(r.url()));
          await p.waitForFunction(() => !document.getElementById('note-editor').disabled);
          return p;
        }
      }
    }
    await sleep(100);
  }
  throw new Error('side panel page not found');
}

const claimed = new Set();
async function targetId(p) {
  const s = await p.context().newCDPSession(p);
  const { targetInfo } = await s.send('Target.getTargetInfo');
  await s.detach();
  return targetInfo.targetId;
}

async function storage(sw) {
  return sw.evaluate(() => chrome.storage.local.get(null));
}

async function waitSaved(panel) {
  await panel.waitForFunction(() => /^Saved/.test(document.getElementById('save-status').textContent), null, { timeout: 6000 });
}

// ------------------------------------------------------------------ run 1
console.log('Run 1: fresh profile');
let env = await launch();
const meetTab = env.ctx.pages()[0] || await env.ctx.newPage();
await meetTab.goto(MEET_A);
const otherTab = await env.ctx.newPage();
await otherTab.goto(OTHER);
const teamsTab = await env.ctx.newPage();
await teamsTab.goto(TEAMS);
const liveTab = await env.ctx.newPage();
await liveTab.goto(TEAMS_LIVE);
await sleep(300);

// Side panel enablement per site
const opts = await env.sw.evaluate(async () => {
  const out = {};
  for (const t of await chrome.tabs.query({})) {
    out[t.url] = {
      panel: (await chrome.sidePanel.getOptions({ tabId: t.id })).enabled,
      action: await chrome.action.isEnabled(t.id),
    };
  }
  out.behavior = await chrome.sidePanel.getPanelBehavior();
  return out;
});
assert.deepEqual(opts[MEET_A], { panel: true, action: true }); ok('panel + icon enabled on meet.google.com');
assert.deepEqual(opts[TEAMS], { panel: true, action: true }); ok('panel + icon enabled on teams.microsoft.com');
assert.deepEqual(opts[TEAMS_LIVE], { panel: true, action: true }); ok('panel + icon enabled on teams.live.com');
assert.deepEqual(opts[OTHER], { panel: false, action: false }); ok('panel + icon disabled on other sites');
assert.equal(opts.behavior.openPanelOnActionClick, true); ok('clicking the icon opens the panel (setPanelBehavior)');

const commands = await env.sw.evaluate(() => chrome.commands.getAll());
const cmd = commands.find((c) => c.name === '_execute_action');
assert.equal(cmd.shortcut, 'Alt+N'); ok('Alt+N shortcut registered for the action');

// Open panel on Meet A
await meetTab.bringToFront();
let panel = await openPanel(env, meetTab, MEET_A);
assert.equal(await panel.textContent('#site-badge'), 'Meet');
assert.equal(await panel.textContent('#call-label'), 'abc-defg-hij');
ok('panel opens on Meet and shows meeting code abc-defg-hij');

await panel.fill('#note-editor', '# Meeting A\n- **point one**\n- [x] done item');
await waitSaved(panel);
let st = await storage(env.sw);
assert.match(st['note:meet:abc-defg-hij'].content, /Meeting A/);
ok('notes autosave to chrome.storage.local under note:meet:abc-defg-hij');

// Preview
await panel.click('#mode-preview');
const previewHtml = await panel.innerHTML('#note-preview');
assert.match(previewHtml, /<h1>Meeting A<\/h1>/);
assert.match(previewHtml, /<strong>point one<\/strong>/);
assert.match(previewHtml, /type="checkbox" disabled="" checked=""/);
await panel.click('#mode-edit');
ok('Markdown preview renders headings, bold and task lists');

// Switch meeting in the same tab -> separate notes
await meetTab.goto(MEET_B);
await panel.waitForFunction(() => document.getElementById('call-label').textContent === 'xyz-abcd-efg');
assert.equal(await panel.inputValue('#note-editor'), '');
await panel.fill('#note-editor', 'Notes for meeting B');
await waitSaved(panel);
await meetTab.goto(MEET_A);
await panel.waitForFunction(() => document.getElementById('call-label').textContent === 'abc-defg-hij');
assert.match(await panel.inputValue('#note-editor'), /^# Meeting A/);
st = await storage(env.sw);
assert.equal(st['note:meet:xyz-abcd-efg'].content, 'Notes for meeting B');
assert.match(st['note:meet:abc-defg-hij'].content, /Meeting A/);
ok('notes from different meetings stay separate (A ↔ B in the same tab)');

// URL without code keeps the current call (sticky)
await meetTab.goto('https://meet.google.com/landing');
await sleep(300);
assert.equal(await panel.textContent('#call-label'), 'abc-defg-hij');
await meetTab.goto(MEET_A);
ok('a Meet URL without a code keeps the current call');

// General notes
await panel.click('#scope-general');
assert.equal(await panel.inputValue('#note-editor'), '');
await panel.fill('#note-editor', 'General stuff');
await waitSaved(panel);
await panel.click('#scope-call');
assert.match(await panel.inputValue('#note-editor'), /^# Meeting A/);
st = await storage(env.sw);
assert.equal(st['note:general'].content, 'General stuff');
ok('General notes are separate and always available');

// Timer
const t1 = await panel.textContent('#timer-display');
assert.match(t1, /^\d\d:\d\d$/);
await panel.click('#timer-toggle');
assert.equal(await panel.textContent('#timer-toggle'), 'Start');
const paused = await panel.textContent('#timer-display');
await sleep(1200);
assert.equal(await panel.textContent('#timer-display'), paused);
await panel.click('#timer-reset');
assert.equal(await panel.textContent('#timer-display'), '00:00');
await panel.click('#timer-toggle');
await panel.waitForFunction(() => document.getElementById('timer-display').textContent !== '00:00', null, { timeout: 4000 });
ok('timer runs, pauses, resets and restarts');

// Prep sets + cards
await panel.click('#tabbtn-prep');
await panel.click('#set-new');
await panel.fill('#set-name-input', 'INA interview');
await panel.click('#set-name-form button[type=submit]');
await panel.click('#bulk-panel summary');
await panel.fill('#bulk-text', 'Q: Tell me about yourself\nA: Eight years in product\n- led team of 5\n\nQ: Why INA?\nA: Mission fit');
await panel.click('#bulk-form button[type=submit]');
assert.equal(await panel.locator('#card-list .card').count(), 2);
assert.equal(await panel.locator('.card-body:visible').count(), 0);
await panel.click('#card-list .card:first-child .card-head');
assert.equal(await panel.locator('.card-body:visible').count(), 1);
assert.match(await panel.innerHTML('.card-body .answer'), /<li>led team of 5<\/li>/);
await panel.click('#card-list .card:first-child .card-head');
assert.equal(await panel.locator('.card-body:visible').count(), 0);
ok('prep set created, Q/A pasted as 2 cards, cards collapse/expand');

await panel.click('#add-card-panel summary');
await panel.fill('#card-q', 'Salary expectations');
await panel.fill('#card-a', 'Range 70-80k');
await panel.click('#card-form button[type=submit]');
assert.equal(await panel.locator('#card-list .card').count(), 3);
ok('single card added');

// Second set and switching
await panel.click('#set-new');
await panel.fill('#set-name-input', 'Properstar call');
await panel.click('#set-name-form button[type=submit]');
assert.equal(await panel.locator('#card-list .card').count(), 0);
const sets = await panel.$$eval('#prep-set-select option', (o) => o.map((x) => x.textContent));
assert.equal(sets.length, 3);
const inaId = await panel.$eval('#prep-set-select', (s) => [...s.options].find((o) => o.textContent.startsWith('INA')).value);
await panel.selectOption('#prep-set-select', inaId);
assert.equal(await panel.locator('#card-list .card').count(), 3);
st = await storage(env.sw);
assert.equal(st['note:meet:abc-defg-hij'].prepSetId, inaId);
ok('multiple named sets; chosen set is remembered for this call');

// Ask checklist
await panel.click('#tabbtn-ask');
for (const q of ['What does success look like in 6 months?', 'Team size?']) {
  await panel.fill('#ask-input', q);
  await panel.click('#ask-form button[type=submit]');
}
assert.equal(await panel.locator('#ask-list li').count(), 2);
await panel.check('#ask-list li:first-child input');
assert.equal(await panel.textContent('#ask-progress'), '1 of 2 asked');
st = await storage(env.sw);
assert.equal(st['note:meet:abc-defg-hij'].ticks[inaId].length, 1);
ok('questions-to-ask checklist: add, tick, progress saved for this call');

// Ticks are per call: meeting B starts unticked, same set
await meetTab.goto(MEET_B);
await panel.waitForFunction(() => document.getElementById('call-label').textContent === 'xyz-abcd-efg');
await panel.selectOption('#ask-set-select', inaId);
assert.equal(await panel.textContent('#ask-progress'), '0 of 2 asked');
await meetTab.goto(MEET_A);
await panel.waitForFunction(() => document.getElementById('call-label').textContent === 'abc-defg-hij');
assert.equal(await panel.textContent('#ask-progress'), '1 of 2 asked');
ok('ticks are stored per call');

// History + export
await panel.click('#tabbtn-history');
await panel.waitForSelector('#history-list li');
const titles = await panel.$$eval('.history-title', (n) => n.map((x) => x.textContent));
assert.ok(titles.includes('Meet abc-defg-hij') && titles.includes('Meet xyz-abcd-efg'), titles.join(','));
const meta = await panel.$$eval('.history-meta', (n) => n.map((x) => x.textContent));
assert.ok(meta.every((m) => m.startsWith('Google Meet · ')));
ok('history lists past meetings with site, code and date');

const md = await panel.evaluate(async () => buildMarkdown(await loadRecord('meet:abc-defg-hij')));
assert.match(md, /^# Meet abc-defg-hij/);
assert.match(md, /- \*\*Meeting code:\*\* abc-defg-hij/);
assert.match(md, /## Questions to ask \(INA interview\)\n\n- \[x\] What does success/);
const txt = await panel.evaluate(async () => buildText(await loadRecord('meet:abc-defg-hij')));
assert.match(txt, /Site: Google Meet/);
assert.match(txt, /\[ \] Team size\?/);

// Real download click from the panel
const dlPromise = panel.waitForEvent('download', { timeout: 3000 }).catch(() => null);
const itemA = panel.locator('.history-item', { hasText: 'abc-defg-hij' });
await itemA.locator('button', { hasText: '.md' }).click();
const dl = await dlPromise;
if (dl) {
  assert.match(dl.suggestedFilename(), /^call-notes_meet_abc-defg-hij_\d{4}-\d\d-\d\d\.md$/);
  ok(`.md download from history works (${dl.suggestedFilename()})`);
} else {
  ok('.md / .txt export content correct (download event not observable over CDP)');
}
await itemA.locator('button', { hasText: 'Copy' }).click();
await panel.waitForFunction(() => document.getElementById('toast').textContent === 'Copied to clipboard');
ok('copy to clipboard');

// Delete meeting B note
const itemB = panel.locator('.history-item', { hasText: 'xyz-abcd-efg' });
await itemB.locator('button', { hasText: 'Delete' }).click();
await itemB.locator('button', { hasText: 'Delete?' }).click();
await panel.waitForFunction(() => ![...document.querySelectorAll('.history-title')].some((n) => n.textContent.includes('xyz')));
st = await storage(env.sw);
assert.equal(st['note:meet:xyz-abcd-efg'], undefined);
assert.ok(st['note:meet:abc-defg-hij']);
ok('delete removes only that note (with confirm click)');

// Safety: markdown escaping
const xss = await panel.evaluate(() => renderMarkdown('<img src=x onerror=alert(1)> [a](javascript:alert(1)) ![p](https://x.test/p.png)'));
assert.ok(!/<img/.test(xss) && !/href="javascript/.test(xss) && /\[image: p\]/.test(xss), xss);
ok('markdown preview escapes HTML, blocks javascript: links, never loads images');

const parsed = await panel.evaluate(() => [
  parseCallUrl('https://meet.google.com/abc-defg-hij?authuser=1'),
  parseCallUrl('https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_ZmQ5@thread.v2/0?context=x'),
  parseCallUrl('https://teams.microsoft.com/meet/2345678901234?p=x'),
  parseCallUrl('https://teams.microsoft.com/v2/'),
]);
assert.deepEqual(parsed, [
  { site: 'meet', code: 'abc-defg-hij' },
  { site: 'teams', code: 'meeting_ZmQ5' },
  { site: 'teams', code: '2345678901234' },
  { site: 'teams', code: null },
]);
ok('meeting code parsing for Meet and Teams URL formats');

// Teams panel
await teamsTab.bringToFront();
const teamsPanel = await openPanel(env, teamsTab, TEAMS);
assert.equal(await teamsPanel.textContent('#site-badge'), 'Teams');
assert.equal(await teamsPanel.getAttribute('#call-label', 'title'), 'meeting_NjE4ZTk2YmQtZGVm');
assert.equal(await teamsPanel.inputValue('#note-editor'), '');
await teamsPanel.fill('#note-editor', 'Teams call notes');
await waitSaved(teamsPanel);
st = await storage(env.sw);
assert.equal(st['note:teams:meeting_NjE4ZTk2YmQtZGVm'].content, 'Teams call notes');
ok('panel opens on teams.microsoft.com with its own notes');

// Teams URL losing the code keeps the call; naming a code-less call
await teamsTab.goto('https://teams.microsoft.com/v2/');
await sleep(300);
assert.equal(await teamsPanel.inputValue('#note-editor'), 'Teams call notes');
ok('Teams URL without a meeting id keeps the current call notes');

const livePanel = await openPanel(env, liveTab, TEAMS_LIVE);
assert.equal(await livePanel.textContent('#call-label'), '9381234567890');
ok('panel opens on teams.live.com and reads the meeting id');

// Teams page with no meeting id: name the call to get separate notes
const bareTab = await env.ctx.newPage();
await bareTab.goto('https://teams.microsoft.com/v2/?tab=calendar');
await sleep(300);
const barePanel = await openPanel(env, bareTab, 'https://teams.microsoft.com/v2/?tab=calendar');
assert.equal(await barePanel.textContent('#call-label'), 'No meeting code yet');
assert.equal(await barePanel.isDisabled('#scope-call'), true);
await barePanel.click('#name-call-btn');
await barePanel.fill('#name-call-input', 'Properstar call');
await barePanel.click('#name-call-form button[type=submit]');
await barePanel.waitForFunction(() => document.getElementById('call-label').textContent === 'Properstar call');
await barePanel.fill('#note-editor', 'Named call notes');
await waitSaved(barePanel);
st = await storage(env.sw);
assert.equal(st['note:teams:named:properstar-call'].content, 'Named call notes');
assert.equal(st['note:teams:named:properstar-call'].label, 'Properstar call');
ok('a Teams call without a code can be named and gets its own notes');

// Optional screenshots for a visual check (light + dark)
if (SHOTS) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await meetTab.bringToFront();
  await panel.click('#tabbtn-notes');
  await panel.click('#mode-preview');
  for (const scheme of ['light', 'dark']) {
    await panel.emulateMedia({ colorScheme: scheme });
    await panel.screenshot({ path: path.join(SHOTS, `notes-${scheme}.png`) });
    await panel.click('#tabbtn-prep');
    await panel.screenshot({ path: path.join(SHOTS, `prep-${scheme}.png`) });
    await panel.click('#tabbtn-ask');
    await panel.screenshot({ path: path.join(SHOTS, `ask-${scheme}.png`) });
    await panel.click('#tabbtn-history');
    await panel.screenshot({ path: path.join(SHOTS, `history-${scheme}.png`) });
    await panel.click('#tabbtn-notes');
  }
}

// Privacy: panel pages made no network requests
for (const p of [panel, teamsPanel, livePanel, barePanel]) {
  const external = p.__requests.filter((u) => !u.startsWith('chrome-extension://') && !u.startsWith('blob:'));
  assert.deepEqual(external, []);
  assert.deepEqual(p.__errors, []);
}
ok('no network requests and no console errors from the panel');

for (const c of env.cdps) await c.close().catch(() => {});
await env.ctx.close();

// ------------------------------------------------------------------ run 2
console.log('Run 2: Chrome restarted with the same profile');
env = await launch();
const tab2 = env.ctx.pages()[0] || await env.ctx.newPage();
await tab2.goto(MEET_A);
await sleep(300);
const panel2 = await openPanel(env, tab2, MEET_A);
assert.match(await panel2.inputValue('#note-editor'), /^# Meeting A\n- \*\*point one\*\*/);
ok('meeting notes persist after closing and reopening Chrome');
await panel2.click('#scope-general');
assert.equal(await panel2.inputValue('#note-editor'), 'General stuff');
ok('General notes persist');
await panel2.click('#tabbtn-prep');
const setNames = await panel2.$$eval('#prep-set-select option', (o) => o.map((x) => x.textContent));
assert.ok(setNames.some((n) => n.startsWith('INA interview (3 cards, 2 questions)')), setNames.join('|'));
assert.equal(await panel2.$eval('#prep-set-select', (s) => s.selectedOptions[0].textContent.split(' (')[0]), 'INA interview');
ok('prep sets persist and the set chosen for this call is restored');
await panel2.click('#tabbtn-ask');
assert.equal(await panel2.textContent('#ask-progress'), '1 of 2 asked');
ok('ticks persist');
const st2 = await storage(env.sw);
assert.ok(st2['note:teams:meeting_NjE4ZTk2YmQtZGVm']);
assert.equal(st2['note:meet:xyz-abcd-efg'], undefined);
ok('Teams note persisted; deleted note stays deleted');

for (const c of env.cdps) await c.close().catch(() => {});
await env.ctx.close();
fs.rmSync(PROFILE, { recursive: true, force: true });
console.log(`\nAll ${passed} checks passed.`);
