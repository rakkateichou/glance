importScripts("config.js");

// Uploads this browser's history to Glance, which keeps the history of every device with
// this extension for its search box suggestions. Also handles requests relayed by content.js.

const API_URL = new URL("api/browser-history/", GLANCE_URL).href;
const BATCH_SIZE = 1000;

// Glance itself, and search result pages which would duplicate search suggestions
const EXCLUDED_URLS = [
    /^https?:\/\/(www\.)?google\.[a-z.]+\/search/,
    /^https?:\/\/(www\.)?duckduckgo\.com\/\?/,
    /^https?:\/\/(www\.)?bing\.com\/search/,
];

const isExcluded = (url) => !/^https?:/.test(url) || url.startsWith(GLANCE_URL) || EXCLUDED_URLS.some((pattern) => pattern.test(url));

async function post(path, body) {
    const response = await fetch(API_URL + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${path}: ${response.status} ${await response.text()}`);
    }
}

// Tells this browser's uploads apart from other devices', so clearing its whole history
// only removes what came from it
async function getDeviceID() {
    let { deviceID } = await chrome.storage.local.get("deviceID");
    if (!deviceID) {
        deviceID = crypto.randomUUID();
        await chrome.storage.local.set({ deviceID });
    }
    return deviceID;
}

// Uploads everything visited since the last successful sync (the whole history the first
// time), plus deletions that couldn't be sent at the time
let currentSync = null;

function syncHistory() {
    currentSync ??= uploadHistory().catch((error) => console.error("Glance history sync failed:", error)).finally(() => currentSync = null);
    return currentSync;
}

async function uploadHistory() {
    const deviceID = await getDeviceID();
    const { syncedUntil = 0, pendingDeletes = [] } = await chrome.storage.local.get(["syncedUntil", "pendingDeletes"]);

    for (const body of pendingDeletes) {
        await post("delete", body);
    }
    await chrome.storage.local.set({ pendingDeletes: [] });

    const startedAt = Date.now();
    // An hour of overlap, so titles that loaded after a page was uploaded get updated
    const items = await chrome.history.search({
        text: "",
        startTime: Math.max(0, syncedUntil - 60 * 60 * 1000),
        maxResults: 1000000,
    });

    const visits = items
        .filter((item) => !isExcluded(item.url))
        .map((item) => ({
            url: item.url,
            title: item.title || "",
            visits: item.visitCount,
            typed: item.typedCount,
            lastVisit: Math.round(item.lastVisitTime),
        }));

    for (let i = 0; i < visits.length; i += BATCH_SIZE) {
        await post("visits", { device: deviceID, visits: visits.slice(i, i + BATCH_SIZE) });
    }

    await chrome.storage.local.set({ syncedUntil: startedAt });
}

async function deleteFromGlance(body) {
    try {
        await post("delete", body);
    } catch (error) {
        // e.g. away from the network Glance is on, sent with the next sync
        const { pendingDeletes = [] } = await chrome.storage.local.get("pendingDeletes");
        await chrome.storage.local.set({ pendingDeletes: [...pendingDeletes, body] });
    }
}

const scheduleRetries = () => chrome.alarms.create("retry-sync", { periodInMinutes: 30 });

chrome.runtime.onInstalled.addListener(() => {
    scheduleRetries();
    syncHistory();
});

chrome.runtime.onStartup.addListener(() => {
    scheduleRetries();
    syncHistory();
});

// New visits go up at most a minute later, without syncing on every single page load
chrome.history.onVisited.addListener(async () => {
    if (!(await chrome.alarms.get("sync"))) {
        await chrome.alarms.create("sync", { delayInMinutes: 1 });
    }
});

chrome.alarms.onAlarm.addListener(() => syncHistory());

chrome.history.onVisitRemoved.addListener(async ({ allHistory, urls }) => {
    if (allHistory) {
        await deleteFromGlance({ device: await getDeviceID(), all: true });
    } else if (urls?.length) {
        await deleteFromGlance({ urls });
    }
});

// From Glance's search box, through content.js
const handlers = {
    // Removed from Glance by the page itself, this removes it from this browser too
    "delete-visit": async ({ url }) => {
        await chrome.history.deleteUrl({ url });
        return { ok: true };
    },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return false;

    handler(message).then(sendResponse, (error) => sendResponse({ error: String(error) }));
    return true; // responding asynchronously
});
