// Answers browser history lookups from Glance's search box, relayed by content.js

const handlers = {
    "search-visits": searchVisits,
    "typed-sites": typedSites,
    "delete-visit": deleteVisit,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return false;

    handler(message).then(sendResponse, (error) => sendResponse({ error: String(error) }));
    return true; // responding asynchronously
});

// Glance itself, and search result pages which would duplicate search suggestions
const EXCLUDED_URLS = [
    /^https:\/\/glance\//,
    /^https?:\/\/(www\.)?google\.[a-z.]+\/search/,
    /^https?:\/\/(www\.)?duckduckgo\.com\/\?/,
    /^https?:\/\/(www\.)?bing\.com\/search/,
];

const isExcluded = (url) => !/^https?:/.test(url) || EXCLUDED_URLS.some((pattern) => pattern.test(url));

// What the omnibox shows for a URL: no scheme, no www., no trailing slash
const displayURL = (url) => url.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Roughly how Chrome's omnibox ranks history matches: how well the text matches (site
// prefix > start of a word > anywhere), how often the page was typed or visited, and how
// recently, with a slight preference for shorter URLs (e.g. a site's home page)
function scoreVisit(item, words, now) {
    const url = displayURL(item.url).toLowerCase();
    const title = (item.title || "").toLowerCase();

    let quality = 0;
    for (const word of words) {
        let wordQuality;
        if (url.startsWith(word)) {
            wordQuality = 3;
        } else if (new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}`).test(`${url} ${title}`)) {
            wordQuality = 2;
        } else if (url.includes(word) || title.includes(word)) {
            wordQuality = 1;
        } else {
            return 0;
        }
        quality += wordQuality;
    }

    const frequency = 1 + Math.log2(1 + item.typedCount * 5 + item.visitCount);
    const daysAgo = (now - item.lastVisitTime) / (24 * 60 * 60 * 1000);
    const recency = 1 / (1 + daysAgo / 14);
    const brevity = 1 / (1 + url.length / 200);

    return quality * frequency * recency * brevity;
}

async function searchVisits({ text, limit = 3 }) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    const items = await chrome.history.search({ text, startTime: 0, maxResults: 200 });
    const now = Date.now();
    const seen = new Set();

    return items
        .filter((item) => item.url && !isExcluded(item.url))
        .map((item) => ({ item, score: scoreVisit(item, words, now) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .filter(({ item }) => {
            // http/https and www/non-www versions of a page show up as one
            const key = displayURL(item.url).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, limit)
        .map(({ item }) => ({ url: item.url, title: item.title || "", text: displayURL(item.url) }));
}

// Sites typed into the address bar before, most typed first, for inline completion
// (typing "you" completes to "youtube.com"). Kept for a minute, since it scans the history.
let typedSitesCache = null;

async function typedSites() {
    if (typedSitesCache && Date.now() - typedSitesCache.at < 60 * 1000) {
        return typedSitesCache.sites;
    }

    const items = await chrome.history.search({ text: "", startTime: 0, maxResults: 10000 });
    const sites = new Map();

    for (const item of items) {
        if (!item.typedCount || isExcluded(item.url)) continue;

        const url = new URL(item.url);
        const site = sites.get(url.host) ?? {
            host: url.host,
            text: url.host.replace(/^www\./, ""),
            url: `${url.protocol}//${url.host}/`,
            typed: 0,
        };
        site.typed += item.typedCount;
        sites.set(url.host, site);
    }

    const sorted = [...sites.values()].sort((a, b) => b.typed - a.typed).slice(0, 500);
    typedSitesCache = { at: Date.now(), sites: sorted };
    return sorted;
}

async function deleteVisit({ url }) {
    await chrome.history.deleteUrl({ url });
    typedSitesCache = null;
    return { ok: true };
}
