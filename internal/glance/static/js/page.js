import { setupPopovers } from './popover.js';
import { setupMasonries } from './masonry.js';
import { throttledDebounce, isElementVisible, openURLInNewTab } from './utils.js';
import { elem, find, findAll } from './templating.js';
import { initSync, subscribe, broadcast } from './sync.js';

async function fetchPageContent(pageData) {
    // TODO: handle non 200 status codes/time outs
    // TODO: add retries
    const response = await fetch(`${pageData.baseURL}/api/pages/${pageData.slug}/content/`);
    const content = await response.text();

    return content;
}

function setupCarousels() {
    const carouselElements = document.getElementsByClassName("carousel-container");

    if (carouselElements.length == 0) {
        return;
    }

    for (let i = 0; i < carouselElements.length; i++) {
        const carousel = carouselElements[i];
        carousel.classList.add("show-right-cutoff");
        const itemsContainer = carousel.getElementsByClassName("carousel-items-container")[0];

        const determineSideCutoffs = () => {
            if (itemsContainer.scrollLeft != 0) {
                carousel.classList.add("show-left-cutoff");
            } else {
                carousel.classList.remove("show-left-cutoff");
            }

            if (Math.ceil(itemsContainer.scrollLeft) + itemsContainer.clientWidth < itemsContainer.scrollWidth) {
                carousel.classList.add("show-right-cutoff");
            } else {
                carousel.classList.remove("show-right-cutoff");
            }
        }

        const determineSideCutoffsRateLimited = throttledDebounce(determineSideCutoffs, 20, 100);

        itemsContainer.addEventListener("scroll", determineSideCutoffsRateLimited);
        window.addEventListener("resize", determineSideCutoffsRateLimited);

        afterContentReady(determineSideCutoffs);
    }
}

const minuteInSeconds = 60;
const hourInSeconds = minuteInSeconds * 60;
const dayInSeconds = hourInSeconds * 24;
const monthInSeconds = dayInSeconds * 30.4;
const yearInSeconds = dayInSeconds * 365;

function timestampToRelativeTime(timestamp) {
    let delta = Math.round((Date.now() / 1000) - timestamp);
    let prefix = "";

    if (delta < 0) {
        delta = -delta;
        prefix = "in ";
    }

    if (delta < minuteInSeconds) {
        return prefix + "1m";
    }
    if (delta < hourInSeconds) {
        return prefix + Math.floor(delta / minuteInSeconds) + "m";
    }
    if (delta < dayInSeconds) {
        return prefix + Math.floor(delta / hourInSeconds) + "h";
    }
    if (delta < monthInSeconds) {
        return prefix + Math.floor(delta / dayInSeconds) + "d";
    }
    if (delta < yearInSeconds) {
        return prefix + Math.floor(delta / monthInSeconds) + "mo";
    }

    return prefix + Math.floor(delta / yearInSeconds) + "y";
}

function updateRelativeTimeForElements(elements)
{
    for (let i = 0; i < elements.length; i++)
    {
        const element = elements[i];
        const timestamp = element.dataset.dynamicRelativeTime;

        if (timestamp === undefined)
            continue

        element.textContent = timestampToRelativeTime(timestamp);
    }
}

// Browser history lookups through the Glance New Tab extension (extension/ in the repo),
// whose content script marks the page and relays these requests to it
function connectBrowserHistory() {
    const extensionURL = document.documentElement.dataset.glanceExtension;
    if (!extensionURL) return null;

    const pending = new Map();
    let nextID = 0;

    window.addEventListener("message", (event) => {
        if (event.source !== window || event.data?.source !== "glance-extension") return;

        const settle = pending.get(event.data.id);
        if (!settle) return;
        pending.delete(event.data.id);
        settle(event.data.response);
    });

    return {
        request: (request) => new Promise((resolve, reject) => {
            const id = nextID++;
            pending.set(id, (response) => response?.error ? reject(new Error(response.error)) : resolve(response));
            window.postMessage({ source: "glance-page", id, request }, location.origin);
        }),
        faviconURL: (pageURL) => `${extensionURL}_favicon/?pageUrl=${encodeURIComponent(pageURL)}&size=32`,
    };
}

function setupSearchBoxes() {
    const searchWidgets = document.getElementsByClassName("search");

    if (searchWidgets.length == 0) {
        return;
    }

    const browserHistory = connectBrowserHistory();

    for (let i = 0; i < searchWidgets.length; i++) {
        const widget = searchWidgets[i];
        const defaultSearchUrl = widget.dataset.defaultSearchUrl;
        const target = widget.dataset.target || "_blank";
        const newTab = widget.dataset.newTab === "true";
        const openDirectURL = widget.dataset.openDirectUrl === "true";
        const googleAutocomplete = widget.dataset.googleAutocomplete === "true";
        const googleAutocompleteLimit = parseInt(widget.dataset.googleAutocompleteLimit) || 0;
        const searchHistoryEnabled = widget.dataset.searchHistory === "true";
        const historyRetentionDays = parseInt(widget.dataset.historyRetention) || 0;
        const inputElement = widget.getElementsByClassName("search-input")[0];
        const bangElement = widget.getElementsByClassName("search-bang")[0];
        const resultsElement = widget.getElementsByClassName("search-autocomplete-results")[0];
        const bangs = widget.querySelectorAll(".search-bangs > input");
        const bangsMap = {};
        const kbdElement = widget.getElementsByTagName("kbd")[0];
        let currentBang = null;
        let lastQuery = "";
        let originalValue = "";
        let selectedIndex = -1;
        // { kind: "history" (past search) | "visit" (browser history page) | "google", text, url?, title? }
        let suggestions = [];
        let lastGoogleSuggestions = [];
        let lastVisits = [];
        let suggestionsRequest = 0;
        // Sites typed into the address bar before, for inline completion, and the one the box is
        // currently completed to
        let typedSites = null;
        let inlineSite = null;
        const suggestionsEnabled = googleAutocomplete || browserHistory != null;
        const itemSuggestions = new WeakMap();

        for (let j = 0; j < bangs.length; j++) {
            const bang = bangs[j];
            bangsMap[bang.dataset.shortcut] = bang;
        }

        // --- History Helpers ---
        const getHistory = () => {
            try {
                const raw = localStorage.getItem('search-history') || "[]";
                let history = JSON.parse(raw);

                // Migration & Pruning
                const now = Date.now();
                const msPerDay = 24 * 60 * 60 * 1000;
                let changed = false;

                history = history.map(item => {
                    // Convert old string-only format to new object format
                    if (typeof item === 'string') {
                        changed = true;
                        return { q: item, t: now };
                    }
                    return item;
                });

                if (historyRetentionDays > 0) {
                    const cutoff = now - (historyRetentionDays * msPerDay);
                    const lengthBefore = history.length;
                    history = history.filter(item => item.t > cutoff);
                    if (history.length !== lengthBefore) changed = true;
                }

                if (changed) {
                    localStorage.setItem('search-history', JSON.stringify(history));
                }

                return history;
            } catch (e) {
                return [];
            }
        };
        const saveToHistory = (query) => {
            try {
                let history = getHistory();
                const now = Date.now();
                // Move to top and update timestamp
                history = [{ q: query, t: now }, ...history.filter(h => h.q !== query)].slice(0, 50);
                localStorage.setItem('search-history', JSON.stringify(history));
                broadcast('search-history', JSON.stringify(history));
            } catch (e) {
                // Silently ignore storage errors
            }
        };
        const removeFromHistory = (query) => {
            let history = getHistory();
            history = history.filter(h => h.q !== query);
            localStorage.setItem('search-history', JSON.stringify(history));
            broadcast('search-history', JSON.stringify(history));
            fetchSuggestions(inputElement.value.trim()); // Refresh
        };
        // -----------------------

        const performSearch = (query, template, ctrlKey) => {
            let url;
            const urlPattern = /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}(\/.*)?$/i;

            const q = query.trim();
            if (q.length === 0 && currentBang == null) return;

            // Save to history if enabled
            if (searchHistoryEnabled && q.length > 0) {
                saveToHistory(q);
            }

            if (openDirectURL && currentBang == null && urlPattern.test(q)) {
                url = q.includes("://") ? query : "http://" + query;
            } else {
                url = template.replace("!QUERY!", encodeURIComponent(q));
            }

            lastQuery = q;
            navigate(url, ctrlKey);
        };

        const navigate = (url, ctrlKey) => {
            if (newTab && !ctrlKey || !newTab && ctrlKey) {
                window.open(url, target).focus();
                inputElement.value = "";
                originalValue = "";
                hideAutocomplete();
            } else {
                window.location.href = url;
            }
        };

        const activateSuggestion = (suggestion, ctrlKey) => {
            if (suggestion.kind === "visit") {
                navigate(suggestion.url, ctrlKey);
            } else {
                performSearch(suggestion.text, defaultSearchUrl, ctrlKey);
            }
        };

        const removeSuggestion = (suggestion) => {
            inputElement.value = originalValue;

            if (suggestion.kind === "visit") {
                browserHistory.request({ type: "delete-visit", url: suggestion.url })
                    .then(() => {
                        lastVisits = lastVisits.filter(visit => visit.url !== suggestion.url);
                        fetchSuggestions(inputElement.value.trim());
                    })
                    .catch((e) => console.error("Browser history error:", e));
            } else {
                removeFromHistory(suggestion.text);
            }
        };

        const loadTypedSites = () => {
            typedSites = [];
            browserHistory.request({ type: "typed-sites" })
                .then((sites) => typedSites = sites)
                .catch((e) => console.error("Browser history error:", e));
        };

        const handleKeyDown = (event) => {
            if (event.key == "Escape") {
                // Like Chrome, the first Escape reverts to what was typed (dropping the selected
                // suggestion or inline completion) and closes the suggestions, the next one blurs
                if (!resultsElement.classList.contains("hidden")) {
                    inputElement.value = originalValue;
                    hideAutocomplete();
                    return;
                }

                inputElement.blur();
                return;
            }

            if (suggestionsEnabled && suggestions.length > 0) {
                const isDown = event.key === "ArrowDown" || (event.key === "j" && event.ctrlKey);
                const isUp = event.key === "ArrowUp" || (event.key === "k" && event.ctrlKey);

                if (isDown || isUp) {
                    event.preventDefault();

                    // If we haven't started navigating yet, the current value (what the user typed) is our base
                    if (selectedIndex === -1) {
                        // Note: originalValue is already set in handleInput
                    }

                    if (isDown) {
                        selectedIndex++;
                        if (selectedIndex >= suggestions.length) selectedIndex = -1;
                    } else {
                        selectedIndex--;
                        if (selectedIndex < -1) selectedIndex = suggestions.length - 1;
                    }

                    inputElement.value = selectedIndex === -1 ? originalValue : suggestions[selectedIndex].text;

                    // Like Chrome, put the caret at the end so typing, space and backspace
                    // continue from the selected suggestion
                    const end = inputElement.value.length;
                    inputElement.setSelectionRange(end, end);

                    updateSelection();
                    return;
                }

                // Like Chrome, Shift+Delete removes the selected past search or visited page
                if (event.key === "Delete" && event.shiftKey && selectedIndex >= 0 && suggestions[selectedIndex].kind !== "google") {
                    event.preventDefault();
                    removeSuggestion(suggestions[selectedIndex]);
                    return;
                }
            }

            // Like Chrome, arrow down reopens suggestions after they were closed with Escape
            if (suggestionsEnabled && suggestions.length === 0 && event.key === "ArrowDown" && inputElement.value.trim() && !currentBang) {
                event.preventDefault();
                fetchSuggestions(inputElement.value.trim());
                return;
            }

            if (event.key == "Enter") {
                if (selectedIndex >= 0) {
                    activateSuggestion(suggestions[selectedIndex], event.ctrlKey);
                    return;
                }

                // The box holds a site it was inline completed to, open it like Chrome would
                if (inlineSite && inputElement.value === inlineSite.text && currentBang == null) {
                    navigate(inlineSite.url, event.ctrlKey);
                    return;
                }

                const input = inputElement.value.trim();
                let query;
                let searchUrlTemplate;

                if (currentBang != null) {
                    query = input.slice(currentBang.dataset.shortcut.length + 1);
                    searchUrlTemplate = currentBang.dataset.url;
                } else {
                    query = input;
                    searchUrlTemplate = defaultSearchUrl;
                }

                performSearch(query, searchUrlTemplate, event.ctrlKey);
                return;
            }

            if (event.key == "ArrowUp" && lastQuery.length > 0 && (!suggestionsEnabled || suggestions.length === 0)) {
                inputElement.value = lastQuery;
                return;
            }
        };

        const updateSelection = () => {
            const items = resultsElement.getElementsByClassName("search-autocomplete-item");
            for (let i = 0; i < items.length; i++) {
                items[i].classList.toggle("selected", i === selectedIndex);
            }
        };

        const hideAutocomplete = () => {
            resultsElement.classList.add("hidden");
            suggestions = [];
            selectedIndex = -1;
        };

        const suggestionKey = (suggestion) => JSON.stringify([suggestion.kind, suggestion.text, suggestion.url ?? "", suggestion.title ?? ""]);

        const fillItem = (item, suggestion) => {
            item.innerHTML = "";
            item.dataset.key = suggestionKey(suggestion);
            item.classList.toggle("search-history-item", suggestion.kind === "history");
            item.classList.toggle("search-visit-item", suggestion.kind === "visit");
            itemSuggestions.set(item, suggestion);

            if (suggestion.kind === "visit") {
                // Like Chrome: favicon, page title, then the URL
                const text = elem("span").classes("search-autocomplete-text", "search-visit-text")
                    .append(elem("span").classes("search-visit-title").text(suggestion.title || suggestion.text));
                if (suggestion.title) {
                    text.append(elem("span").classes("search-visit-url").text(suggestion.text));
                }
                item.append(
                    elem("img").classes("search-visit-icon").attrs({ src: browserHistory.faviconURL(suggestion.url), alt: "" }),
                    text,
                );
            } else {
                item.append(elem("span").classes("search-autocomplete-text").text(suggestion.text));
            }

            if (suggestion.kind !== "google") {
                const removeBtn = elem("div").classes("search-history-remove").text("✕");
                removeBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    removeSuggestion(suggestion);
                });
                item.append(removeBtn);
            }
        };

        const renderSuggestions = (query) => {
            const lowerQuery = query.toLowerCase();
            let historySuggestions = [];

            if (searchHistoryEnabled && lowerQuery) {
                historySuggestions = getHistory()
                    .filter(item => item.q.toLowerCase().includes(lowerQuery) && !lastGoogleSuggestions.includes(item.q))
                    .slice(0, 3)
                    .map(item => ({ kind: "history", text: item.q }));
            }

            const queries = [...historySuggestions, ...lastGoogleSuggestions.map(text => ({ kind: "google", text }))];
            const limitedQueries = googleAutocompleteLimit > 0 ? queries.slice(0, googleAutocompleteLimit) : queries;
            const historyCount = Math.min(historySuggestions.length, limitedQueries.length);

            // Pages from the browser history go after past searches, and don't count toward the
            // limit, which is for search suggestions
            const visits = lastVisits.map(visit => ({ kind: "visit", text: visit.text, url: visit.url, title: visit.title }));
            const newSuggestions = [...limitedQueries.slice(0, historyCount), ...visits, ...limitedQueries.slice(historyCount)];

            if (JSON.stringify(suggestions) === JSON.stringify(newSuggestions)) {
                return;
            }

            const currentDOMItems = Array.from(resultsElement.getElementsByClassName("search-autocomplete-item"));

            newSuggestions.forEach((suggestion, i) => {
                const existing = currentDOMItems[i];

                if (existing) {
                    // Update existing item
                    if (existing.dataset.key !== suggestionKey(suggestion)) {
                        fillItem(existing, suggestion);
                        existing.style.animation = 'none';
                        existing.offsetHeight;
                        existing.style.animation = null;
                    }
                } else {
                    // Append new item
                    const item = elem("div").classes("search-autocomplete-item");
                    fillItem(item, suggestion);
                    item.styles({ animationDelay: `${i * 30}ms` });
                    item.addEventListener("click", (e) => {
                        activateSuggestion(itemSuggestions.get(item), e.ctrlKey);
                    });
                    resultsElement.append(item);
                }
            });

            // Clean up extra items
            if (currentDOMItems.length > newSuggestions.length) {
                currentDOMItems.slice(newSuggestions.length).forEach(item => item.remove());
            }

            suggestions = newSuggestions;
            if (suggestions.length === 0) {
                hideAutocomplete();
                return;
            }

            resultsElement.classList.remove("hidden");
            selectedIndex = -1;
            updateSelection();
        };

        const fetchSuggestions = throttledDebounce(async (query) => {
            if (!query) {
                hideAutocomplete();
                return;
            }

            // INSTANT: Show matching past searches right away, keeping the previous suggestions
            // that still match (like Chrome) instead of closing the list on every keystroke
            const lowerQuery = query.toLowerCase();
            lastGoogleSuggestions = lastGoogleSuggestions.filter(s => s.toLowerCase().startsWith(lowerQuery));
            lastVisits = lastVisits.filter(visit => visit.text.toLowerCase().includes(lowerQuery) || visit.title.toLowerCase().includes(lowerQuery));
            renderSuggestions(query);

            // Only use responses for the latest input, and only if the box still starts with
            // what was sent (not the inline completed text)
            const request = ++suggestionsRequest;
            const isCurrent = () => request === suggestionsRequest && inputElement.value.toLowerCase().startsWith(lowerQuery);
            const updates = [];

            if (browserHistory) {
                updates.push(browserHistory.request({ type: "search-visits", text: query })
                    .then((visits) => {
                        if (!isCurrent()) return;
                        lastVisits = visits;
                        renderSuggestions(query);
                    })
                    .catch((e) => console.error("Browser history error:", e)));
            }

            if (googleAutocomplete) {
                updates.push(fetch(`${pageData.baseURL}/api/autocomplete?q=${encodeURIComponent(query)}`)
                    .then((response) => response.json())
                    .then((data) => {
                        if (!isCurrent()) return;
                        lastGoogleSuggestions = data[1] || [];
                        renderSuggestions(query);
                    })
                    .catch((e) => console.error("Autocomplete error:", e)));
            }

            await Promise.all(updates);
        }, 5, 200);

        if (searchHistoryEnabled) {
            subscribe((key) => {
                if (key === 'search-history' && document.activeElement === inputElement) {
                    fetchSuggestions(inputElement.value.trim());
                }
            });
        }

        const changeCurrentBang = (bang) => {
            currentBang = bang;
            bangElement.textContent = bang != null ? bang.dataset.title : "";
        }

        const handleInput = (event) => {
            const userTypedValue = inputElement.value; 
            const trimmedValue = userTypedValue.trim();
            originalValue = userTypedValue; // Capture the real typing for the arrow-key logic

            // Editing the text drops the selected suggestion, so Enter searches what's in the box
            // even before the new suggestions arrive
            selectedIndex = -1;
            updateSelection();

            // 1. Fetch suggestions for exactly what the user typed
            if (suggestionsEnabled && !currentBang) {
                fetchSuggestions(trimmedValue);
            } else {
                hideAutocomplete();
            }

            // 2. Inline Typeahead: Fill the box with a past search, or else (like Chrome) a site
            // typed into the address bar before, but DON'T affect the suggestions fetch. Not when
            // deleting (Backspace or Delete), so the completion can be removed.
            inlineSite = null;
            if (!event.inputType?.startsWith("delete") && userTypedValue.length > 0) {
                const lowerTyped = userTypedValue.toLowerCase();
                let completion = null;

                if (searchHistoryEnabled) {
                    completion = getHistory().find(item => item.q.toLowerCase().startsWith(lowerTyped))?.q ?? null;
                }

                if (completion == null && typedSites && !/\s/.test(userTypedValue)) {
                    const site = typedSites.find(site => site.text.startsWith(lowerTyped) || site.host.startsWith(lowerTyped));
                    if (site) {
                        completion = site.text.startsWith(lowerTyped) ? site.text : site.host;
                        inlineSite = { text: completion, url: site.url };
                    }
                }

                if (completion != null && completion.length > userTypedValue.length) {
                    inputElement.value = completion;
                    inputElement.setSelectionRange(userTypedValue.length, completion.length);
                }
            }

            if (trimmedValue in bangsMap) {
                changeCurrentBang(bangsMap[trimmedValue]);
                return;
            }

            const words = trimmedValue.split(" ");
            if (words.length >= 2 && words[0] in bangsMap) {
                changeCurrentBang(bangsMap[words[0]]);
                return;
            }

            changeCurrentBang(null);
        };

        const attachListeners = () => {
            document.addEventListener("keydown", handleKeyDown);
            inputElement.addEventListener("input", handleInput);

            if (browserHistory && typedSites == null) {
                loadTypedSites();
            }
        };

        const detachListeners = () => {
            document.removeEventListener("keydown", handleKeyDown);
            inputElement.removeEventListener("input", handleInput);
        };

        inputElement.addEventListener("focus", attachListeners);
        inputElement.addEventListener("blur", detachListeners);

        // If the element is already focused (e.g. via browser native autofocus with SSR),
        // we need to attach the listeners immediately.
        if (document.activeElement === inputElement) {
            attachListeners();
        }

        // Robust native autofocus fix
        if (inputElement.hasAttribute("autofocus")) {
            const focus = () => {
                inputElement.focus();
                // Ensure we "win" the focus battle if other scripts/transitions are running
                setTimeout(() => inputElement.focus(), 10);
            };
            
            // If the element is already visible, focus it. 
            // Otherwise, wait for the content-ready transition.
            if (isElementVisible(inputElement)) {
                focus();
            } else {
                afterContentReady(focus);
            }
        }

        document.addEventListener("keydown", (event) => {
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
            if (event.code != "KeyS") return;

            inputElement.focus();
            event.preventDefault();
        });

        kbdElement.addEventListener("mousedown", () => {
            requestAnimationFrame(() => inputElement.focus());
        });
    }
}

function setupDynamicRelativeTime() {
    const elements = document.querySelectorAll("[data-dynamic-relative-time]");
    const updateInterval = 60 * 1000;
    let lastUpdateTime = Date.now();

    updateRelativeTimeForElements(elements);

    const updateElementsAndTimestamp = () => {
        updateRelativeTimeForElements(elements);
        lastUpdateTime = Date.now();
    };

    const scheduleRepeatingUpdate = () => setInterval(updateElementsAndTimestamp, updateInterval);

    if (document.hidden === undefined) {
        scheduleRepeatingUpdate();
        return;
    }

    let timeout = scheduleRepeatingUpdate();

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            clearTimeout(timeout);
            return;
        }

        const delta = Date.now() - lastUpdateTime;

        if (delta >= updateInterval) {
            updateElementsAndTimestamp();
            timeout = scheduleRepeatingUpdate();
            return;
        }

        timeout = setTimeout(() => {
            updateElementsAndTimestamp();
            timeout = scheduleRepeatingUpdate();
        }, updateInterval - delta);
    });
}

function setupGroups() {
    const groups = document.getElementsByClassName("widget-type-group");

    if (groups.length == 0) {
        return;
    }

    for (let g = 0; g < groups.length; g++) {
        const group = groups[g];
        const titles = group.getElementsByClassName("widget-header")[0].children;
        const tabs = group.getElementsByClassName("widget-group-contents")[0].children;
        let current = 0;

        for (let t = 0; t < titles.length; t++) {
            const title = titles[t];

            if (title.dataset.titleUrl !== undefined) {
                title.addEventListener("mousedown", (event) => {
                    if (event.button != 1) {
                        return;
                    }

                    openURLInNewTab(title.dataset.titleUrl, false);
                    event.preventDefault();
                });
            }

            title.addEventListener("click", () => {
                if (t == current) {
                    if (title.dataset.titleUrl !== undefined) {
                        openURLInNewTab(title.dataset.titleUrl);
                    }

                    return;
                }

                for (let i = 0; i < titles.length; i++) {
                    titles[i].classList.remove("widget-group-title-current");
                    titles[i].setAttribute("aria-selected", "false");
                    tabs[i].classList.remove("widget-group-content-current");
                    tabs[i].setAttribute("aria-hidden", "true");
                }

                if (current < t) {
                    tabs[t].dataset.direction = "right";
                } else {
                    tabs[t].dataset.direction = "left";
                }

                current = t;

                title.classList.add("widget-group-title-current");
                title.setAttribute("aria-selected", "true");
                tabs[t].classList.add("widget-group-content-current");
                tabs[t].setAttribute("aria-hidden", "false");
            });
        }
    }
}

function setupLazyImages() {
    const images = document.querySelectorAll("img[loading=lazy]");

    if (images.length == 0) {
        return;
    }

    function imageFinishedTransition(image) {
        image.classList.add("finished-transition");
    }

    afterContentReady(() => {
        setTimeout(() => {
            for (let i = 0; i < images.length; i++) {
                const image = images[i];

                if (image.complete) {
                    image.classList.add("cached");
                    setTimeout(() => imageFinishedTransition(image), 1);
                } else {
                    // TODO: also handle error event
                    image.addEventListener("load", () => {
                        image.classList.add("loaded");
                        setTimeout(() => imageFinishedTransition(image), 400);
                    });
                }
            }
        }, 1);
    });
}

function attachExpandToggleButton(collapsibleContainer) {
    const showMoreText = "Show more";
    const showLessText = "Show less";

    let expanded = false;
    const button = document.createElement("button");
    const icon = document.createElement("span");
    icon.classList.add("expand-toggle-button-icon");
    const textNode = document.createTextNode(showMoreText);
    button.classList.add("expand-toggle-button");
    button.append(textNode, icon);
    button.addEventListener("click", () => {
        expanded = !expanded;

        if (expanded) {
            collapsibleContainer.classList.add("container-expanded");
            button.classList.add("container-expanded");
            textNode.nodeValue = showLessText;
            return;
        }

        const topBefore = button.getClientRects()[0].top;

        collapsibleContainer.classList.remove("container-expanded");
        button.classList.remove("container-expanded");
        textNode.nodeValue = showMoreText;

        const topAfter = button.getClientRects()[0].top;

        if (topAfter > 0)
            return;

        window.scrollBy({
            top: topAfter - topBefore,
            behavior: "instant"
        });
    });

    collapsibleContainer.after(button);

    return button;
};


function setupCollapsibleLists() {
    const collapsibleLists = document.querySelectorAll(".list.collapsible-container");

    if (collapsibleLists.length == 0) {
        return;
    }

    for (let i = 0; i < collapsibleLists.length; i++) {
        const list = collapsibleLists[i];

        if (list.dataset.collapseAfter === undefined) {
            continue;
        }

        const collapseAfter = parseInt(list.dataset.collapseAfter);

        if (collapseAfter == -1) {
            continue;
        }

        if (list.children.length <= collapseAfter) {
            continue;
        }

        attachExpandToggleButton(list);

        for (let c = collapseAfter; c < list.children.length; c++) {
            const child = list.children[c];
            child.classList.add("collapsible-item");
            child.style.animationDelay = ((c - collapseAfter) * 20).toString() + "ms";
        }
    }
}

function setupCollapsibleGrids() {
    const collapsibleGridElements = document.querySelectorAll(".cards-grid.collapsible-container");

    if (collapsibleGridElements.length == 0) {
        return;
    }

    for (let i = 0; i < collapsibleGridElements.length; i++) {
        const gridElement = collapsibleGridElements[i];

        if (gridElement.dataset.collapseAfterRows === undefined) {
            continue;
        }

        const collapseAfterRows = parseInt(gridElement.dataset.collapseAfterRows);

        if (collapseAfterRows == -1) {
            continue;
        }

        const getCardsPerRow = () => {
            return parseInt(getComputedStyle(gridElement).getPropertyValue('--cards-per-row'));
        };

        const button = attachExpandToggleButton(gridElement);

        let cardsPerRow;

        const resolveCollapsibleItems = () => requestAnimationFrame(() => {
            const hideItemsAfterIndex = cardsPerRow * collapseAfterRows;

            if (hideItemsAfterIndex >= gridElement.children.length) {
                button.style.display = "none";
            } else {
                button.style.removeProperty("display");
            }

            let row = 0;

            for (let i = 0; i < gridElement.children.length; i++) {
                const child = gridElement.children[i];

                if (i >= hideItemsAfterIndex) {
                    child.classList.add("collapsible-item");
                    child.style.animationDelay = (row * 40).toString() + "ms";

                    if (i % cardsPerRow + 1 == cardsPerRow) {
                        row++;
                    }
                } else {
                    child.classList.remove("collapsible-item");
                    child.style.removeProperty("animation-delay");
                }
            }
        });

        const observer = new ResizeObserver(() => {
            if (!isElementVisible(gridElement)) {
                return;
            }

            const newCardsPerRow = getCardsPerRow();

            if (cardsPerRow == newCardsPerRow) {
                return;
            }

            cardsPerRow = newCardsPerRow;
            resolveCollapsibleItems();
        });

        afterContentReady(() => observer.observe(gridElement));
    }
}

const contentReadyCallbacks = [];

function afterContentReady(callback) {
    contentReadyCallbacks.push(callback);
}

const weekDayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function makeSettableTimeElement(element, hourFormat) {
    const fragment = document.createDocumentFragment();
    const hour = document.createElement('span');
    const minute = document.createElement('span');
    const amPm = document.createElement('span');
    fragment.append(hour, document.createTextNode(':'), minute);

    if (hourFormat == '12h') {
        fragment.append(document.createTextNode(' '), amPm);
    }

    element.append(fragment);

    return (date) => {
        const hours = date.getHours();

        if (hourFormat == '12h') {
            amPm.textContent = hours < 12 ? 'AM' : 'PM';
            hour.textContent = hours % 12 || 12;
        } else {
            hour.textContent = hours < 10 ? '0' + hours : hours;
        }

        const minutes = date.getMinutes();
        minute.textContent = minutes < 10 ? '0' + minutes : minutes;
    };
};

function timeInZone(now, zone) {
    let timeInZone;

    try {
        timeInZone = new Date(now.toLocaleString('en-US', { timeZone: zone }));
    } catch (e) {
        // TODO: indicate to the user that this is an invalid timezone
        console.error(e);
        timeInZone = now
    }

    const diffInMinutes = Math.round((timeInZone.getTime() - now.getTime()) / 1000 / 60);

    return { time: timeInZone, diffInMinutes: diffInMinutes };
}

function zoneDiffText(diffInMinutes) {
    if (diffInMinutes == 0) {
        return "";
    }

    const sign = diffInMinutes < 0 ? "-" : "+";
    const signText = diffInMinutes < 0 ? "behind" : "ahead";

    diffInMinutes = Math.abs(diffInMinutes);

    const hours = Math.floor(diffInMinutes / 60);
    const minutes = diffInMinutes % 60;
    const hourSuffix = hours == 1 ? "" : "s";

    if (minutes == 0) {
        return { text: `${sign}${hours}h`, title: `${hours} hour${hourSuffix} ${signText}` };
    }

    if (hours == 0) {
        return { text: `${sign}${minutes}m`, title: `${minutes} minutes ${signText}` };
    }

    return { text: `${sign}${hours}h~`, title: `${hours} hour${hourSuffix} and ${minutes} minutes ${signText}` };
}

function setupClocks() {
    const clocks = document.getElementsByClassName('clock');

    if (clocks.length == 0) {
        return;
    }

    const updateCallbacks = [];

    for (var i = 0; i < clocks.length; i++) {
        const clock = clocks[i];
        const hourFormat = clock.dataset.hourFormat;
        const localTimeContainer = clock.querySelector('[data-local-time]');
        const localDateElement = localTimeContainer.querySelector('[data-date]');
        const localWeekdayElement = localTimeContainer.querySelector('[data-weekday]');
        const localYearElement = localTimeContainer.querySelector('[data-year]');
        const timeZoneContainers = clock.querySelectorAll('[data-time-in-zone]');

        const setLocalTime = makeSettableTimeElement(
            localTimeContainer.querySelector('[data-time]'),
            hourFormat
        );

        updateCallbacks.push((now) => {
            setLocalTime(now);
            localDateElement.textContent = now.getDate() + ' ' + monthNames[now.getMonth()];
            localWeekdayElement.textContent = weekDayNames[now.getDay()];
            localYearElement.textContent = now.getFullYear();
        });

        for (var z = 0; z < timeZoneContainers.length; z++) {
            const timeZoneContainer = timeZoneContainers[z];
            const diffElement = timeZoneContainer.querySelector('[data-time-diff]');

            const setZoneTime = makeSettableTimeElement(
                timeZoneContainer.querySelector('[data-time]'),
                hourFormat
            );

            updateCallbacks.push((now) => {
                const { time, diffInMinutes } = timeInZone(now, timeZoneContainer.dataset.timeInZone);
                setZoneTime(time);
                const { text, title } = zoneDiffText(diffInMinutes);
                diffElement.textContent = text;
                diffElement.title = title;
            });
        }
    }

    const updateClocks = () => {
        const now = new Date();

        for (var i = 0; i < updateCallbacks.length; i++)
            updateCallbacks[i](now);

        setTimeout(updateClocks, (60 - now.getSeconds()) * 1000);
    };

    updateClocks();
}

async function setupCalendars() {
    const elems = document.getElementsByClassName("calendar");
    if (elems.length == 0) return;

    // animations.js is imported by calendar.js, fetching it alongside avoids a waterfall
    const [calendar] = await Promise.all([import('./calendar.js'), import('./animations.js')]);

    for (let i = 0; i < elems.length; i++)
        calendar.default(elems[i]);
}

async function setupCounters() {
    const elems = Array.from(document.getElementsByClassName("counters"));
    if (elems.length === 0) return;
    const counters = await import ('./counters.js');
    for (let i = 0; i < elems.length; i++) {
        counters.default(elems[i]);
    }
}

async function setupTodos() {
    const elems = Array.from(document.getElementsByClassName("todo"));
    if (elems.length == 0) return;

    // animations.js is imported by todo.js, fetching it alongside avoids a waterfall
    const [todo] = await Promise.all([import('./todo.js'), import('./animations.js')]);

    for (let i = 0; i < elems.length; i++){
        todo.default(elems[i]);
    }
}

function setupTruncatedElementTitles() {
    const elements = document.querySelectorAll(".text-truncate, .single-line-titles .title, .text-truncate-2-lines, .text-truncate-3-lines");

    if (elements.length == 0) {
        return;
    }

    for (let i = 0; i < elements.length; i++) {
        const element = elements[i];
        if (element.getAttribute("title") === null)
            element.title = element.innerText.trim().replace(/\s+/g, " ");
    }
}

async function changeTheme(key, onChanged) {
    const themeStyleElem = find("#theme-style");

    const response = await fetch(`${pageData.baseURL}/api/set-theme/${key}`, {
        method: "POST",
    });

    if (response.status != 200) {
        alert("Failed to set theme: " + response.statusText);
        return;
    }
    const newThemeStyle = await response.text();

    const tempStyle = elem("style")
        .html("* { transition: none !important; }")
        .appendTo(document.head);

    themeStyleElem.html(newThemeStyle);
    document.documentElement.setAttribute("data-theme", key);
    document.documentElement.setAttribute("data-scheme", response.headers.get("X-Scheme"));
    typeof onChanged == "function" && onChanged();
    setTimeout(() => { tempStyle.remove(); }, 10);
}

function initThemePicker() {
    const themeChoicesInMobileNav = find(".mobile-navigation .theme-choices");
    if (!themeChoicesInMobileNav) return;

    const themeChoicesInHeader = find(".header-container .theme-choices");

    if (themeChoicesInHeader) {
        themeChoicesInHeader.replaceWith(
            themeChoicesInMobileNav.cloneNode(true)
        );
    }

    const presetElems = findAll(".theme-choices .theme-preset");
    let themePreviewElems = document.getElementsByClassName("current-theme-preview");
    let isLoading = false;

    presetElems.forEach((presetElement) => {
        const themeKey = presetElement.dataset.key;

        if (themeKey === undefined) {
            return;
        }

        if (themeKey == pageData.theme) {
            presetElement.classList.add("current");
        }

        presetElement.addEventListener("click", () => {
            if (themeKey == pageData.theme) return;
            if (isLoading) return;

            isLoading = true;
            changeTheme(themeKey, function() {
                isLoading = false;
                pageData.theme = themeKey;
                presetElems.forEach((e) => { e.classList.remove("current"); });

                Array.from(themePreviewElems).forEach((preview) => {
                    preview.querySelector(".theme-preset").replaceWith(
                        presetElement.cloneNode(true)
                    );
                })

                presetElems.forEach((e) => {
                    if (e.dataset.key != themeKey) return;
                    e.classList.add("current");
                });
            });
        });
    })
}

async function setupServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            await navigator.serviceWorker.register(`${pageData.baseURL}/sw.js`, {
                scope: `${pageData.baseURL}/`,
                updateViaCache: 'none'
            });
        } catch (error) {
            console.error('[PWA] Service Worker registration failed:', error);
        }
    }
}

async function setupPage() {
    initThemePicker();
    initSync(pageData.baseURL);
    setupServiceWorker();

    const pageElement = document.getElementById("page");
    const pageContentElement = document.getElementById("page-content");

    if (pageContentElement.innerHTML.trim() === "") {
        const pageContent = await fetchPageContent(pageData);
        pageContentElement.innerHTML = pageContent;
    }

    try {
        setupPopovers();
        setupClocks();
        setupSearchBoxes();
        setupCarousels();
        await setupCalendars();
        await setupCounters();
        await setupTodos();
        setupCollapsibleLists();
        setupCollapsibleGrids();
        setupGroups();
        setupMasonries();
        setupDynamicRelativeTime();
        setupLazyImages();
    } finally {
        pageElement.classList.add("content-ready");
        pageElement.setAttribute("aria-busy", "false");

        for (let i = 0; i < contentReadyCallbacks.length; i++) {
            contentReadyCallbacks[i]();
        }

        setTimeout(() => {
            setupTruncatedElementTitles();
        }, 50);

        setTimeout(() => {
            document.body.classList.add("page-columns-transitioned");
        }, 300);
    }
}

setupPage();
