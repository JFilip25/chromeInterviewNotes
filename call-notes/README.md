# Call Notes

A Chrome extension that opens your notes and prepared talking points in Chrome's
side panel, next to a **Google Meet** or **Microsoft Teams** call. It doesn't
cover the call, you don't switch tabs, and everything stays on your computer.

- **Notes:** a Markdown editor with a preview toggle. It saves automatically. Each
  meeting gets its own notes, and there's also a "General" note that's always available.
- **Prep:** collapsible question/answer cards, grouped into named sets
  ("INA interview", "Properstar call"). You pick which set to use for each call.
- **Ask:** a checklist of questions to ask them, which you tick off during the call.
- **Timer:** shows the time since you opened the panel, with Pause/Start and Reset.
- **History:** your past meeting notes. Open, copy, export as `.md` / `.txt`, or delete them.

---

## Install

1. Open **chrome://extensions** in Chrome (version 116 or newer).
2. Turn on **Developer mode** (switch in the top-right corner).
3. Click **Load unpacked** and select the `call-notes` folder (the one that
   contains `manifest.json`).
4. Optional: click the puzzle-piece icon in the toolbar and **pin** Call Notes
   so its icon is always visible.

If you edit the files later, click the reload icon on the Call Notes card in
chrome://extensions.

## Open the panel

On a `meet.google.com`, `teams.microsoft.com` or `teams.live.com` tab:

- click the **Call Notes** icon in the toolbar, or
- press **Alt+N** (Option+N on a Mac).

On other sites the icon is greyed out and the panel isn't available. To prepare
before a call, open `https://meet.google.com` (the landing page is enough) and
open the panel there.

### Change the keyboard shortcut

Go to **chrome://extensions/shortcuts**, find **Call Notes → Open Call Notes**,
click the pencil icon and press the keys you want. If Alt+N is already used by
another extension, Chrome leaves the shortcut empty, and you set it here.

## Notes

- **This call / General:** "This call" holds the notes for the meeting in the
  current tab. "General" is one note that's always there, whatever the meeting.
- **Edit / Preview:** you write Markdown (`# heading`, `**bold**`, `*italic*`,
  `- bullet`, `1. numbered`, `- [ ] task`, `` `code` ``, `> quote`, links).
  Preview shows it formatted.
- **Autosave:** notes save 1 second after you stop typing, at least every 3
  seconds while you type, and when the panel closes. **Ctrl/Cmd+S** saves right
  away. The status under the editor shows when the note was last saved.
- **A− / A+** in the header change the text size.

### How meetings are told apart

| Site | Key used for the notes |
| --- | --- |
| Google Meet | the code in the URL, e.g. `abc-defg-hij` |
| Teams meeting link | the meeting id in the link (`19:meeting_…@thread.v2`) |
| Teams "meet" link | the numeric meeting id, e.g. `teams.live.com/meet/9381234567890` |

Teams often removes the meeting id from the URL after you join. When that
happens, the panel keeps showing the meeting it last saw in that tab. If the
URL never had an id, click **Name this call** in the header and type a name.
Typing the same name later brings back the same notes. **Rename** gives any
call a friendlier title for History and exports.

## Prep cards

1. Open the **Prep** tab.
2. Click **New** next to "Prep set for this call" and give the set a name, e.g.
   `INA interview`. Use the dropdown to pick the set for the current call. The
   panel remembers your choice for that meeting.
3. Add cards in one of two ways:
   - **Add a card:** a question or topic, plus the answer or talking points
     (Markdown works, so bullet lists are fine).
   - **Paste many cards:** paste a batch in any of these formats:

     ```text
     Q: Tell me about yourself
     A: 8 years in product, last 3 leading a team of 5

     Q: Why this company?
     A: - Mission fit
        - Growth market
     ```

     ```text
     ## Tell me about yourself
     8 years in product…

     ## Why this company?
     Mission fit…
     ```

     Or blocks separated by blank lines, where the first line of each block is
     the question.
4. During the call, click a question to expand its answer. **One at a time**
   closes the others automatically. **Filter cards…** finds a card fast. Open
   cards have ↑ ↓ (reorder), **Edit** and **Delete** buttons.

## Questions to ask them (Ask tab)

The questions belong to the prep set, so you can write them before the call.
Ticks are saved **per call**, so the next call with the same set starts with
everything unticked. Click **×** twice to remove a question. **Untick all**
clears the ticks for this call.

## History and export

- **History** lists your saved meeting notes, newest first, with site, meeting
  code and date. Use the search box to filter them.
- **Open** shows a past note in the editor. You can edit it, and **Back to
  current** returns to the call.
- **Copy** puts the note on the clipboard as Markdown.
- **.md** / **.txt** downloads the note. Exports include the site, meeting code,
  date, your notes, and the questions-to-ask checklist showing which ones were
  ticked.
- **Delete** asks for a second click to confirm.
- To export the note that's open in the editor (including General), use the
  Copy / .md / .txt buttons under the editor.

## Privacy and permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | to show the panel |
| `storage` | to save notes and prep cards in `chrome.storage.local` |
| `tabs` | to read the current tab's URL (meeting code) |
| host access to `meet.google.com`, `teams.microsoft.com`, `teams.live.com` | to turn the panel on only for those sites |

- **No network requests.** The extension's Content Security Policy sets
  `connect-src 'none'`, and Markdown images are shown as text and never loaded.
  There are no fonts, libraries or analytics loaded from the internet.
- **Nothing is injected into Meet or Teams.** There are no content scripts and
  no `scripting` permission. The extension can't see the call's audio, video or
  chat.
- Data stays in your Chrome profile. **Removing the extension deletes all its
  data**, so export anything you want to keep first.

## Files

```text
call-notes/
├── manifest.json    MV3 manifest: permissions, side panel, Alt+N, CSP
├── background.js    enables the panel only on Meet/Teams; icon click opens it
├── sidepanel.html   panel layout (header + timer, 4 tabs)
├── sidepanel.css    styles, light/dark tokens, text sizes
├── sidepanel.js     all panel logic (notes, prep, ask, history, export)
└── icons/           toolbar and store icons
```

Saved data in `chrome.storage.local`:

- `note:general`, `note:meet:<code>`, `note:teams:<id>`, `note:<site>:named:<name>`:
  one record per note, holding the text, the chosen prep set, and the
  ticked questions
- `prep:sets`: your prep sets, cards and questions
- `settings`: text size and a few UI preferences

## Tests

An automated end-to-end test (`tests/e2e.mjs`, in the repository root) loads the
extension into real Chromium with Playwright. It serves fake Meet/Teams pages
locally, opens the actual side panel, and checks the following:

- the panel is enabled on meet.google.com, teams.microsoft.com and teams.live.com, and disabled elsewhere
- notes autosave, and different meetings (and General) keep separate notes
- prep sets, cards, the checklist, history, export and delete work
- the panel makes no network requests and logs no console errors
- after restarting Chrome with the same profile, notes, sets and ticks are all still there

```bash
npm install
npx playwright install chromium
npm test
```

Note: Microsoft is moving web Teams to `teams.cloud.microsoft`. If your Teams
opens there, add `https://teams.cloud.microsoft/*` to `host_permissions` in
`manifest.json` and `teams.cloud.microsoft` to `SUPPORTED_HOSTS` in
`background.js` and `parseCallUrl()` in `sidepanel.js`.
