# Call Notes (Chrome extension)

Notes, prep cards, a questions-to-ask checklist and a call timer in Chrome's side
panel, next to Google Meet and Microsoft Teams. Manifest V3, plain HTML/CSS/JS,
no build step, no network requests.

- Extension source and full instructions: [`call-notes/`](call-notes/README.md)
- End-to-end test: [`tests/e2e.mjs`](tests/e2e.mjs) (`npm install && npx playwright install chromium && npm test`)

Quick install: open `chrome://extensions`, turn on **Developer mode**, click
**Load unpacked**, and select the `call-notes` folder. Then press **Alt+N** (or
click the icon) on a Meet or Teams tab.
