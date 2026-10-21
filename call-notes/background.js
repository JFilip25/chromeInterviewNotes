/**
 * Call Notes: background service worker.
 *
 * Responsibilities (and nothing else):
 *   1. Make a click on the toolbar icon (or the Alt+N shortcut, which triggers
 *      the action) open the side panel.
 *   2. Enable the side panel only on Google Meet and Microsoft Teams tabs, and
 *      disable it everywhere else.
 *
 * This file never touches page content, never injects scripts and never makes
 * network requests. It only reads tab URLs to decide whether a tab is supported.
 */

'use strict';

/** Hostnames where the side panel is available. Must match host_permissions. */
const SUPPORTED_HOSTS = [
  'meet.google.com',
  'teams.microsoft.com',
  'teams.live.com',
  'teams.cloud.microsoft', // Microsoft's newer Teams web domain
];

const PANEL_PATH = 'sidepanel.html';

/**
 * True when the URL belongs to one of the supported call sites.
 * @param {string | undefined} url
 */
function isSupportedUrl(url) {
  if (!url) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && SUPPORTED_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

/**
 * Turn the side panel (and the toolbar icon) on or off for one tab,
 * depending on its URL.
 * @param {number} tabId
 * @param {string | undefined} url
 */
async function applyTabState(tabId, url) {
  const supported = isSupportedUrl(url);
  try {
    if (supported) {
      await chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true });
      await chrome.action.enable(tabId);
      await chrome.action.setTitle({ tabId, title: 'Open Call Notes' });
    } else {
      // Disabling also closes the panel if the tab navigates away from a call site.
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
      await chrome.action.disable(tabId);
      await chrome.action.setTitle({
        tabId,
        title: 'Call Notes: available on Google Meet and Microsoft Teams',
      });
    }
  } catch {
    // The tab was probably closed before we finished. Nothing to do.
  }
}

/** Apply the right state to every open tab (used after install and on startup). */
async function initAllTabs() {
  // Clicking the icon opens the panel instead of firing action.onClicked.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // Off by default everywhere; switched on per tab below.
  await chrome.sidePanel.setOptions({ enabled: false });
  await chrome.action.disable();

  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => applyTabState(tab.id, tab.url)));
}

chrome.runtime.onInstalled.addListener(() => {
  initAllTabs();
});

chrome.runtime.onStartup.addListener(() => {
  initAllTabs();
});

// Re-check whenever a tab's URL changes or a page finishes loading.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    applyTabState(tabId, tab.url);
  }
});

// Prerendered / instant pages can swap one tab for another.
chrome.tabs.onReplaced.addListener(async (addedTabId) => {
  try {
    const tab = await chrome.tabs.get(addedTabId);
    applyTabState(tab.id, tab.url);
  } catch {
    // Tab no longer exists.
  }
});
