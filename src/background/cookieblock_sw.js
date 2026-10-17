//-------------------------------------------------------------------------------
/*
Copyright (C) 2021-2022 Dino Bollinger, ETH Zürich, Information Security Group

This file is part of CookieBlock.

Released under the MIT License, see included LICENSE file.
*/
//-------------------------------------------------------------------------------
//
// cookieblock_sw.js — Manifest V3 Service Worker entry point
//
// Replaces the MV2 background.html + background.js pair.
//
// Script load order (importScripts is synchronous):
//   1. Third-party utilities (lz-string, levenshtein, difflib)
//   2. globals_sw.js  — SW-safe utilities: fetch-based file loader, storage
//                        helpers, string utilities.  NO document.* or XHR.
//   3. extractor.js   — Feature extraction (unmodified)
//   4. predictor.js   — ML prediction (unmodified)
//   5. cookieblock_background.js — Core logic: classification, policy, IDB helpers.
//                                   Contains function definitions only; no
//                                   top-level listener registrations.
//
// ensureInitialized() is the single initialization gate:
//   • Loads default_config.json and known_cookies.json via fetch()
//   • (Re-)opens the CookieBlockHistory IndexedDB connection
//   • Is idempotent: caches its in-flight Promise so repeated calls are cheap
//   • On failure, resets the cache so the next event can retry
//   • Awaited at the top of every event listener that touches extension state
//-------------------------------------------------------------------------------

importScripts(
    "/modules/third_party/lz-string.js",
    "/modules/third_party/levenshtein.js",
    "/modules/third_party/difflib-browser.js",
    "/modules/globals_sw.js",
    "/modules/extractor.js",
    "/modules/predictor.js",
    "/background/cookieblock_background.js"
);


// ─────────────────────────────────────────────────────────────────────────────
// Initialization Gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cached initialization Promise.
 *  - null  → not yet started (also reset to null after a failed attempt)
 *  - Promise<void> (pending)  → init in progress; new callers await the same promise
 *  - Promise<void> (resolved) → init complete; await resolves immediately
 *
 * Because this is a module-level variable it is reset to null whenever the
 * Service Worker is terminated and restarted, ensuring fresh initialization
 * on every SW wake-up cycle.
 *
 * @type {Promise<void>|null}
 */
let _initPromise = null;


/**
 * Idempotent Service Worker initialization guard.
 *
 * Step 1 — Load default_config.json via fetch() and store it in the global
 *           `defaultConfig` variable (defined in globals_sw.js).  This must
 *           happen before initDefaults() or any getStorageValue() call, because
 *           getStorageValue() uses defaultConfig as a fallback for missing keys.
 *
 * Step 2 — Call initDefaults() to write storage defaults for any key not yet
 *           present in chrome.storage (no-op for keys already set).
 *
 * Step 3 — Load known_cookies.json, compile its domain_regex entries into
 *           RegExp objects, and assign the result to knownCookies_internal.
 *
 * Step 4 — Call openHistoryDB() to open (or re-open) the CookieBlockHistory
 *           IndexedDB database and assign the connection to historyDB.
 *
 * Subsequent calls return the cached promise — no-op if initialization has
 * already completed successfully.  If initialization throws, the cached
 * promise is cleared so the next event listener invocation will retry.
 *
 * @returns {Promise<void>}
 */
const ensureInitialized = function() {
    if (_initPromise !== null) return _initPromise;

    _initPromise = (async () => {
        try {
            // ── Step 1: default config ────────────────────────────────────
            // Must precede initDefaults() so getStorageValue() has a fallback.
            defaultConfig = await fetchExtensionJSON(
                chrome.runtime.getURL("/ext_data/default_config.json")
            );

            // ── Step 2: storage defaults ──────────────────────────────────
            // override=false → only writes keys not already in storage
            await initDefaults(defaultConfig, false);

            // ── Step 3: internal known-cookies list ───────────────────────
            const rawKnown = await fetchExtensionJSON(
                chrome.runtime.getURL("/ext_data/known_cookies.json")
            );
            // Pre-compile domain_regex entries into RegExp objects
            for (let k of Object.keys(rawKnown["domain_regex"])) {
                rawKnown["domain_regex"][k][regexKey] = new RegExp(k);
            }
            knownCookies_internal = rawKnown;

            // ── Steps 4 + 5 + 6: run concurrently ────────────────────────
            // These three are independent of each other and of steps 1–3:
            //   • openHistoryDB()         → (re-)opens CookieBlockHistory IDB
            //   • loadForests()           → fetches 8 model JSON files (predictor.js)
            //   • loadFeatureResources()  → fetches features.json + 6 text resources (extractor.js)
            await Promise.all([
                openHistoryDB(),
                loadForests(),
                loadFeatureResources()
            ]);

            console.info("CookieBlock SW: initialization complete.");
        } catch (err) {
            console.error("CookieBlock SW: initialization failed:", err);
            _initPromise = null;   // Reset → next event will retry
            throw err;
        }
    })();

    return _initPromise;
};


// ─────────────────────────────────────────────────────────────────────────────
// Event Listeners
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirror storage changes into the in-memory cache variables (cblk_* globals).
 * Registered unconditionally — updateStorageVars() only writes to in-memory
 * globals from values that already arrived from storage, so it does not need
 * the full initialization to have completed first.
 */
chrome.storage.onChanged.addListener(updateStorageVars);


/**
 * Main cookie event listener.
 *
 * Called by Chrome every time a cookie is created, modified, or deleted.
 * We only act on non-removal events (additions / updates).
 *
 * ensureInitialized() is awaited on every invocation so that SW restarts
 * (which reset all module-level globals to undefined) are transparently handled
 * before any classification or policy-decision logic runs.
 */
chrome.cookies.onChanged.addListener(async (changeInfo) => {
    try {
        await ensureInitialized();
    } catch (err) {
        console.error("CookieBlock SW: skipping cookie event — init failed:", err);
        return;
    }
    if (!changeInfo.removed) {
        handleCookie(changeInfo.cookie, true, false);
    }
});


/**
 * Message handler for requests from popup and options pages.
 *
 * Because ensureInitialized() is async, the listener always returns `true`
 * to keep the message channel open until sendResponse() is eventually called
 * by handleInternalMessage() (which itself returns true for its own async paths).
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        try {
            await ensureInitialized();
        } catch (err) {
            console.error("CookieBlock SW: message handler init failed:", err);
            // Still attempt to handle the message with whatever state is available
        }
        handleInternalMessage(request, sender, sendResponse);
    })();
    return true;  // Keep channel open for async sendResponse calls
});


/**
 * First-install listener.
 * Opens the setup page when the extension is installed for the first time.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
    try {
        await ensureInitialized();
    } catch (err) {
        console.error("CookieBlock SW: onInstalled init failed:", err);
    }
    if (details.reason === "install") {
        chrome.tabs.create({ "active": true, "url": "/options/cookieblock_setup.html" });
    }
});
