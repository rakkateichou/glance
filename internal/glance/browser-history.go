package glance

import (
	"encoding/json"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Browser history uploaded by the Glance New Tab extension (extension/ in the repo) from
// every device it's installed on, so the search box can suggest visited pages and complete
// typed sites on any device, including ones without the extension

const (
	browserHistoryFile       = "data/browser_history.json"
	browserHistoryMaxEntries = 50000
	browserHistorySaveDelay  = 30 * time.Second
	browserHistoryMaxUpload  = 32 << 20
)

type browserHistoryVisits struct {
	Visits    int   `json:"visits"`
	Typed     int   `json:"typed"`
	LastVisit int64 `json:"lastVisit"` // Unix milliseconds
}

type browserHistoryEntry struct {
	Title   string                           `json:"title"`
	Devices map[string]*browserHistoryVisits `json:"devices"`

	// For searching: the URL as the address bar shows it (no scheme, no www., no trailing
	// slash) and the title, lowercased
	text       string
	lowerText  string
	lowerTitle string
}

type browserHistoryStore struct {
	mu        sync.Mutex
	loadOnce  sync.Once
	entries   map[string]*browserHistoryEntry // by URL
	saveTimer *time.Timer
}

var globalBrowserHistory = &browserHistoryStore{
	entries: make(map[string]*browserHistoryEntry),
}

func browserHistoryDisplayURL(rawURL string) string {
	text := strings.TrimPrefix(strings.TrimPrefix(rawURL, "https://"), "http://")
	return strings.TrimSuffix(strings.TrimPrefix(text, "www."), "/")
}

func (e *browserHistoryEntry) prepare(rawURL string) {
	e.text = browserHistoryDisplayURL(rawURL)
	e.lowerText = strings.ToLower(e.text)
	e.lowerTitle = strings.ToLower(e.Title)
}

func (e *browserHistoryEntry) totals() (visits, typed int, lastVisit int64) {
	for _, device := range e.Devices {
		visits += device.Visits
		typed += device.Typed
		lastVisit = max(lastVisit, device.LastVisit)
	}

	return visits, typed, lastVisit
}

// load only runs once, so a config reload doesn't throw away changes waiting to be saved
func (s *browserHistoryStore) load() {
	s.loadOnce.Do(func() {
		s.mu.Lock()
		defer s.mu.Unlock()

		contents, err := os.ReadFile(browserHistoryFile)
		if err != nil {
			if !os.IsNotExist(err) {
				slog.Error("Failed to read browser history", "error", err)
			}
			return
		}

		if err := json.Unmarshal(contents, &s.entries); err != nil {
			slog.Error("Failed to parse browser history", "error", err)
			s.entries = make(map[string]*browserHistoryEntry)
			return
		}

		for rawURL, entry := range s.entries {
			entry.prepare(rawURL)
		}
	})
}

// Saves are batched, uploads come in bursts. Caller holds mu.
func (s *browserHistoryStore) scheduleSave() {
	if s.saveTimer == nil {
		s.saveTimer = time.AfterFunc(browserHistorySaveDelay, s.save)
	}
}

func (s *browserHistoryStore) save() {
	s.mu.Lock()
	s.saveTimer = nil
	contents, err := json.Marshal(s.entries)
	s.mu.Unlock()

	if err != nil {
		slog.Error("Failed to encode browser history", "error", err)
		return
	}

	// Written next to the file and renamed over it, so a crash mid-write can't corrupt it
	os.MkdirAll(filepath.Dir(browserHistoryFile), os.ModePerm)
	tempFile := browserHistoryFile + ".tmp"
	if err := os.WriteFile(tempFile, contents, 0600); err != nil {
		slog.Error("Failed to save browser history", "error", err)
		return
	}
	if err := os.Rename(tempFile, browserHistoryFile); err != nil {
		slog.Error("Failed to save browser history", "error", err)
	}
}

type uploadedBrowserVisit struct {
	URL   string `json:"url"`
	Title string `json:"title"`
	browserHistoryVisits
}

// The counts are the device's totals for the URL, so uploading the same thing again is harmless
func (s *browserHistoryStore) upsert(device string, visits []uploadedBrowserVisit) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for i := range visits {
		visit := &visits[i]
		parsed, err := url.Parse(visit.URL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			continue
		}

		entry, exists := s.entries[visit.URL]
		if !exists {
			entry = &browserHistoryEntry{Devices: make(map[string]*browserHistoryVisits)}
			s.entries[visit.URL] = entry
		}

		if visit.Title != "" {
			entry.Title = visit.Title
		}

		stats := visit.browserHistoryVisits
		entry.Devices[device] = &stats
		entry.prepare(visit.URL)
	}

	s.pruneOldest()
	s.scheduleSave()
}

// Caller holds mu
func (s *browserHistoryStore) pruneOldest() {
	if len(s.entries) <= browserHistoryMaxEntries {
		return
	}

	type urlAge struct {
		url       string
		lastVisit int64
	}

	ages := make([]urlAge, 0, len(s.entries))
	for rawURL, entry := range s.entries {
		_, _, lastVisit := entry.totals()
		ages = append(ages, urlAge{rawURL, lastVisit})
	}

	sort.Slice(ages, func(i, j int) bool { return ages[i].lastVisit < ages[j].lastVisit })
	for _, age := range ages[:len(ages)-browserHistoryMaxEntries] {
		delete(s.entries, age.url)
	}
}

// Removes the pages from every device's history, including their http/https and www
// variants, which show up as one suggestion
func (s *browserHistoryStore) deleteURLs(urls []string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	texts := make(map[string]bool, len(urls))
	for _, rawURL := range urls {
		texts[strings.ToLower(browserHistoryDisplayURL(rawURL))] = true
	}

	for rawURL, entry := range s.entries {
		if texts[entry.lowerText] {
			delete(s.entries, rawURL)
		}
	}

	s.scheduleSave()
}

// For when a device's whole history was cleared
func (s *browserHistoryStore) deleteDevice(device string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for rawURL, entry := range s.entries {
		delete(entry.Devices, device)
		if len(entry.Devices) == 0 {
			delete(s.entries, rawURL)
		}
	}

	s.scheduleSave()
}

func isAlphanumeric(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
}

// Whether word appears in s at the start of a word
func containsWordStart(s, word string) bool {
	for offset := 0; offset < len(s); {
		i := strings.Index(s[offset:], word)
		if i < 0 {
			return false
		}

		i += offset
		if i == 0 || !isAlphanumeric(s[i-1]) {
			return true
		}
		offset = i + 1
	}

	return false
}

// Roughly how Chrome's address bar ranks history matches: how well the text matches (site
// prefix > start of a word > anywhere), how often the page was typed or visited, and how
// recently, with a slight preference for shorter URLs (e.g. a site's home page)
func (e *browserHistoryEntry) score(words []string, now int64) float64 {
	quality := 0
	for _, word := range words {
		switch {
		case strings.HasPrefix(e.lowerText, word):
			quality += 3
		case containsWordStart(e.lowerText, word) || containsWordStart(e.lowerTitle, word):
			quality += 2
		case strings.Contains(e.lowerText, word) || strings.Contains(e.lowerTitle, word):
			quality += 1
		default:
			return 0
		}
	}

	visits, typed, lastVisit := e.totals()
	frequency := 1 + math.Log2(1+float64(typed*5+visits))
	daysAgo := max(0, float64(now-lastVisit)/float64(24*time.Hour/time.Millisecond))
	recency := 1 / (1 + daysAgo/14)
	brevity := 1 / (1 + float64(len(e.lowerText))/200)

	return float64(quality) * frequency * recency * brevity
}

type browserHistoryResult struct {
	URL   string `json:"url"`
	Title string `json:"title"`
	Text  string `json:"text"`
}

func (s *browserHistoryStore) search(query string, limit int) []browserHistoryResult {
	words := strings.Fields(strings.ToLower(query))
	results := []browserHistoryResult{}
	if len(words) == 0 {
		return results
	}

	type match struct {
		url   string
		entry *browserHistoryEntry
		score float64
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UnixMilli()
	matches := []match{}
	for rawURL, entry := range s.entries {
		if score := entry.score(words, now); score > 0 {
			matches = append(matches, match{rawURL, entry, score})
		}
	}

	sort.Slice(matches, func(i, j int) bool { return matches[i].score > matches[j].score })

	// http/https and www/non-www versions of a page show up as one
	seen := make(map[string]bool)
	for _, m := range matches {
		if len(results) == limit {
			break
		}
		if seen[m.entry.lowerText] {
			continue
		}
		seen[m.entry.lowerText] = true
		results = append(results, browserHistoryResult{URL: m.url, Title: m.entry.Title, Text: m.entry.text})
	}

	return results
}

type typedSite struct {
	Host  string `json:"host"`
	Text  string `json:"text"`
	URL   string `json:"url"`
	Typed int    `json:"typed"`
}

// Sites typed into the address bar before, most typed first, for inline completion
// (typing "you" completes to "youtube.com")
func (s *browserHistoryStore) typedSites() []typedSite {
	s.mu.Lock()
	defer s.mu.Unlock()

	sites := make(map[string]*typedSite)
	for rawURL, entry := range s.entries {
		_, typed, _ := entry.totals()
		if typed == 0 {
			continue
		}

		parsed, err := url.Parse(rawURL)
		if err != nil {
			continue
		}

		site, exists := sites[parsed.Host]
		if !exists {
			site = &typedSite{
				Host: parsed.Host,
				Text: strings.TrimPrefix(parsed.Host, "www."),
				URL:  parsed.Scheme + "://" + parsed.Host + "/",
			}
			sites[parsed.Host] = site
		}
		site.Typed += typed
	}

	sorted := make([]typedSite, 0, len(sites))
	for _, site := range sites {
		sorted = append(sorted, *site)
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Typed > sorted[j].Typed })

	return sorted[:min(len(sorted), 500)]
}

// Requiring a JSON content type means other sites can't post here from the browser, since
// that needs a CORS preflight which isn't allowed. The extension isn't subject to CORS.
func decodeBrowserHistoryRequest(w http.ResponseWriter, r *http.Request, v any) bool {
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" {
		http.Error(w, "expected application/json", http.StatusUnsupportedMediaType)
		return false
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, browserHistoryMaxUpload)).Decode(v); err != nil {
		http.Error(w, "invalid request: "+err.Error(), http.StatusBadRequest)
		return false
	}

	return true
}

func writeBrowserHistoryJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func (a *application) handleBrowserHistoryUpload(w http.ResponseWriter, r *http.Request) {
	if a.handleUnauthorizedResponse(w, r, showUnauthorizedJSON) {
		return
	}

	var request struct {
		Device string                 `json:"device"`
		Visits []uploadedBrowserVisit `json:"visits"`
	}
	if !decodeBrowserHistoryRequest(w, r, &request) {
		return
	}

	if request.Device == "" || len(request.Device) > 100 {
		http.Error(w, "invalid device", http.StatusBadRequest)
		return
	}

	globalBrowserHistory.upsert(request.Device, request.Visits)
	writeBrowserHistoryJSON(w, map[string]int{"received": len(request.Visits)})
}

func (a *application) handleBrowserHistoryDelete(w http.ResponseWriter, r *http.Request) {
	if a.handleUnauthorizedResponse(w, r, showUnauthorizedJSON) {
		return
	}

	var request struct {
		URLs   []string `json:"urls"`
		Device string   `json:"device"`
		All    bool     `json:"all"`
	}
	if !decodeBrowserHistoryRequest(w, r, &request) {
		return
	}

	if request.All && request.Device != "" {
		globalBrowserHistory.deleteDevice(request.Device)
	} else if len(request.URLs) > 0 {
		globalBrowserHistory.deleteURLs(request.URLs)
	}

	writeBrowserHistoryJSON(w, map[string]bool{"ok": true})
}

func (a *application) handleBrowserHistorySearch(w http.ResponseWriter, r *http.Request) {
	if a.handleUnauthorizedResponse(w, r, showUnauthorizedJSON) {
		return
	}

	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit < 1 || limit > 20 {
		limit = 3
	}

	writeBrowserHistoryJSON(w, globalBrowserHistory.search(r.URL.Query().Get("q"), limit))
}

func (a *application) handleBrowserHistoryTypedSites(w http.ResponseWriter, r *http.Request) {
	if a.handleUnauthorizedResponse(w, r, showUnauthorizedJSON) {
		return
	}

	writeBrowserHistoryJSON(w, globalBrowserHistory.typedSites())
}
