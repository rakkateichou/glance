// Lets Glance's search box look things up in the browser history through background.js.
// The page can't use extension APIs itself, so it posts requests to this script, which
// relays them and posts the responses back.

const markPage = () => {
    // Tells the page the extension is there, and where to load favicons from
    document.documentElement.dataset.glanceExtension = chrome.runtime.getURL("");
};

if (document.documentElement) {
    markPage();
} else {
    document.addEventListener("readystatechange", markPage, { once: true });
}

window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "glance-page") return;

    const { id, request } = event.data;
    const reply = (response) => window.postMessage({ source: "glance-extension", id, response }, location.origin);

    chrome.runtime.sendMessage(request).then(reply, (error) => reply({ error: String(error) }));
});
