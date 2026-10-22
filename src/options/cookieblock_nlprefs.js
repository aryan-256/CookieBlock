//-------------------------------------------------------------------------------
/*
Copyright (C) 2021-2022 Dino Bollinger, ETH Zürich, Information Security Group

This file is part of CookieBlock.

Released under the MIT License, see included LICENSE file.
*/
//-------------------------------------------------------------------------------

// ── DOM element references ────────────────────────────────────────────────────

const nlprefsTextarea   = document.getElementById("nlprefs-textarea");
const nlprefsGenBtn     = document.getElementById("nlprefs-generate-btn");
const nlprefsLoading    = document.getElementById("nlprefs-loading");
const nlprefsError      = document.getElementById("nlprefs-error");
const nlprefsResults    = document.getElementById("nlprefs-results");
const nlprefsBadgeFunc  = document.getElementById("nlprefs-badge-func");
const nlprefsBadgeAnal  = document.getElementById("nlprefs-badge-anal");
const nlprefsBadgeAdvert= document.getElementById("nlprefs-badge-advert");
const nlprefsExplanation= document.getElementById("nlprefs-explanation");
const nlprefsApplyBtn   = document.getElementById("nlprefs-apply-btn");
const nlprefsDiscardBtn = document.getElementById("nlprefs-discard-btn");
const nlprefsConfirm    = document.getElementById("nlprefs-confirm");

// ── Module-level state ────────────────────────────────────────────────────────

/** The last validated proposal returned by the model, or null. */
let currentProposal = null;

// ── Constants ─────────────────────────────────────────────────────────────────

const OLLAMA_URL  = "http://localhost:11434/api/chat";
const MODEL_NAME  = "llama3.2:latest";

const SYSTEM_PROMPT = "You configure a browser cookie-consent tool. Decide which cookie categories to ALLOW (true) or BLOCK (false):\n- functionality: preferences, language, UI settings, convenience features\n- analytics: usage statistics and site performance measurement\n- advertising: ad targeting, personalized ads, cross-site tracking\nStrictly-necessary cookies are always allowed; do not output them.\n\nEvaluate each of the three categories independently based on what the user actually said. Do not assume a category is blocked just because another category was mentioned or blocked.\n\nRules:\n1. \"Maximum privacy\", \"block everything\", \"block all\", or any request to keep only what's required/necessary/essential means all three are false.\n2. If the user wants personalized or relevant ads, advertising is true. This does not by itself say anything about functionality or analytics.\n3. If the user says they accept or don't mind a category, that category is true.\n4. If a category is not mentioned and not covered by rule 1, default it to false only if the overall request leans toward privacy; otherwise leave it true.\n5. If the request is not about cookies or privacy, set understood=false and all three false.\n6. If the request contradicts itself, set understood=false and describe the conflict in the explanation.\n7. The explanation is one short sentence, specific to this request, that exactly matches the booleans you chose.";

// ── Helper: show/hide a DOM element ──────────────────────────────────────────

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

// ── Helper: update a read-only badge ─────────────────────────────────────────

/**
 * Set a badge element to ON or OFF state.
 * @param {HTMLElement} badge  The .nlprefs-badge element.
 * @param {boolean}     value  true = ON, false = OFF.
 */
function setBadge(badge, value) {
    if (value) {
        badge.textContent = "ON";
        badge.className   = "nlprefs-badge on";
    } else {
        badge.textContent = "OFF";
        badge.className   = "nlprefs-badge off";
    }
}

// ── Helper: show an error and hide the results area ──────────────────────────

/**
 * Display an error message, hide results, and re-enable the UI for a retry.
 * @param {string} msg  Human-readable error text.
 */
function showError(msg) {
    nlprefsError.textContent = msg;
    show(nlprefsError);
    hide(nlprefsResults);
    hide(nlprefsLoading);
    nlprefsGenBtn.disabled  = false;
    nlprefsApplyBtn.disabled = true;
    currentProposal = null;
}

// ── Helper: clear any previous error/confirm state ───────────────────────────

function clearFeedback() {
    hide(nlprefsError);
    hide(nlprefsConfirm);
    nlprefsError.textContent   = "";
    nlprefsConfirm.textContent = "";
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Defensively validate an object returned by the model.
 * Returns true only if every required field is present and correctly typed.
 * @param {*} obj   Parsed JSON value to validate.
 * @returns {boolean}
 */
function isValidProposal(obj) {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return false;
    const boolFields = ["understood", "functionality", "analytics", "advertising"];
    for (const field of boolFields) {
        if (typeof obj[field] !== "boolean") return false;
    }
    if (typeof obj.explanation !== "string" || obj.explanation.trim().length === 0) return false;
    return true;
}

// ── "Generate" click handler ──────────────────────────────────────────────────

nlprefsGenBtn.addEventListener("click", async () => {
    const userText = nlprefsTextarea.value.trim();
    if (!userText) {
        showError("Please describe your preferences before generating a suggestion.");
        return;
    }

    // Reset UI to loading state
    clearFeedback();
    hide(nlprefsResults);
    nlprefsGenBtn.disabled = true;
    show(nlprefsLoading);
    currentProposal = null;

    // Retrieve classified cookies for the current website tab (if available).
    let siteCookies = [];
    try {
        siteCookies = await getCurrentSiteCookies();
    } catch (err) {
        // Degrade gracefully if query fails — continue without site context
        console.warn("[CookieBlock NL Prefs] Could not retrieve site cookies:", err);
    }

    let userPrompt = userText;
    if (Array.isArray(siteCookies) && siteCookies.length > 0) {
        // Deduplicate by (name, category) pair:
        // In IndexedDB, records can exist for the same cookie name across different
        // paths (e.g. '/' vs '/sub') or subdomain scopes. Deduplicating by (name, category)
        // prevents redundant lines from crowding the prompt and filling the cap.
        const seen = new Set();
        const uniqueCookies = [];
        for (const c of siteCookies) {
            if (!c || !c.name || !c.category) continue;
            const key = `${c.name}:${c.category}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueCookies.push(c);
            }
        }

        if (uniqueCookies.length > 0) {
            // Cap at 30 cookies: 111+ cookies would overwhelm a 3B model's context budget
            // and attention window. 30 provides representative site context without token bloat.
            const MAX_CONTEXT_COOKIES = 30;
            const capped = uniqueCookies.slice(0, MAX_CONTEXT_COOKIES);
            const cookieLines = capped.map((c) => `${c.name}: ${c.category}`).join("\n");
            userPrompt = `Cookies currently set on this site:\n${cookieLines}\n\nUser request: ${userText}`;
        }
    }

    const requestBody = {
        model: MODEL_NAME,
        stream: false,
        format: {
            type: "object",
            properties: {
                understood:    { type: "boolean" },
                functionality: { type: "boolean" },
                analytics:     { type: "boolean" },
                advertising:   { type: "boolean" },
                explanation:   { type: "string"  }
            },
            required: ["understood", "functionality", "analytics", "advertising", "explanation"]
        },
        options: { temperature: 0 },
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: userPrompt }
        ]
    };

    let outerJson;
    try {
        console.log("[CookieBlock NL Prefs] Final userPrompt sent to model:\n" + userPrompt);
        const response = await fetch(OLLAMA_URL, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(requestBody)
        });

        if (!response.ok) {
            showError(`Could not reach the local AI model. Is it running? (HTTP ${response.status})`);
            return;
        }

        outerJson = await response.json();
    } catch (networkErr) {
        showError("Could not reach the local AI model. Is it running?");
        return;
    } finally {
        hide(nlprefsLoading);
        nlprefsGenBtn.disabled = false;
    }

    // Ollama returns the structured output as a JSON *string* inside message.content
    const rawContent = outerJson?.message?.content;
    if (typeof rawContent !== "string") {
        showError("Could not generate a valid suggestion. Please try rephrasing.");
        return;
    }

    let proposal;
    try {
        proposal = JSON.parse(rawContent);
    } catch (parseErr) {
        showError("Could not generate a valid suggestion. Please try rephrasing.");
        return;
    }

    if (!isValidProposal(proposal)) {
        showError("Could not generate a valid suggestion. Please try rephrasing.");
        return;
    }

    // Proposal is structurally valid — display it
    currentProposal = proposal;

    setBadge(nlprefsBadgeFunc,   proposal.functionality);
    setBadge(nlprefsBadgeAnal,   proposal.analytics);
    setBadge(nlprefsBadgeAdvert, proposal.advertising);

    let explanationText = proposal.explanation.trim();
    if (!proposal.understood) {
        explanationText = "I wasn't fully sure I understood — here's my best guess: " + explanationText;
    }
    nlprefsExplanation.textContent = explanationText;

    // Enable Apply only for a valid, structurally sound proposal (even if understood=false)
    nlprefsApplyBtn.disabled = false;
    hide(nlprefsConfirm);

    show(nlprefsResults);
});

// ── "Apply" click handler ─────────────────────────────────────────────────────

nlprefsApplyBtn.addEventListener("click", async () => {
    if (!currentProposal) return;

    try {
        // Read the current policy first to avoid clobbering index 0 (necessary cookies)
        let policy = await getStorageValue(chrome.storage.sync, "cblk_userpolicy");

        // Construct the new policy, preserving index 0 (always true — necessary)
        policy[0] = true;
        policy[1] = currentProposal.functionality;
        policy[2] = currentProposal.analytics;
        policy[3] = currentProposal.advertising;

        // Write back using the same pattern as cookieblock_options.js
        setStorageValue(policy, chrome.storage.sync, "cblk_userpolicy");

        // Show confirmation and clear proposal state
        show(nlprefsConfirm);
        nlprefsConfirm.textContent = "\u2714 Preferences applied";

        // Clear the proposal so Apply cannot be double-clicked
        currentProposal = null;
        nlprefsApplyBtn.disabled = true;
    } catch (err) {
        showError("Failed to save preferences. Please try again.");
        console.error("[CookieBlock NL Prefs] Apply failed:", err);
    }
});

// ── \"Discard\" click handler ───────────────────────────────────────────────────

nlprefsDiscardBtn.addEventListener("click", () => {
    currentProposal = null;
    hide(nlprefsResults);
    clearFeedback();
    nlprefsApplyBtn.disabled = true;
    nlprefsGenBtn.disabled   = false;
    // Leave the textarea contents intact so the user can adjust and retry
});

// ── Per-site cookie context ───────────────────────────────────────────────────

/**
 * Identify the best candidate website tab to use as the cookie-query context.
 *
 * Problem: this page runs as a regular tab (options_ui.open_in_tab: true), so
 * it is itself the "active" tab in its own window.  Any query restricted to the
 * active/focused window returns this extension page, not the website the user
 * came from.
 *
 * Strategy:
 *  1. Query ALL tabs across all windows (no active/window filter).
 *  2. Filter out any tab whose URL starts with this extension's own origin
 *     (chrome.runtime.getURL("") prefix) — removes the NL prefs page, options
 *     page, popup, and any other CookieBlock UI that might be open.
 *  3. Also discard tabs with no URL or a non-http(s) URL (chrome://, about:,
 *     file://, etc.) — we can only query cookie history for web pages.
 *  4. Pick the best remaining tab:
 *     — If tab.lastAccessed is a number (available since Chrome 121; requires
 *       the "tabs" permission to be populated for non-active tabs), sort
 *       descending and take the highest value.
 *     — Otherwise fall back to preferring tabs with active:true (one per
 *       window), then take the first result (order is undefined but stable).
 *
 * No manifest change is required: tab.url is readable without "tabs" permission
 * because the extension already declares "<all_urls>" host_permissions.
 * tab.lastAccessed requires "tabs" permission for non-active tabs; if the
 * permission is absent it will be undefined on those tabs, and the fallback
 * applies automatically.
 *
 * @returns {chrome.tabs.Tab|null} Best candidate tab, or null if none found.
 */
const _findBestWebsiteTab = function(allTabs) {
    const extensionOrigin = chrome.runtime.getURL(""); // "chrome-extension://<id>/"

    const candidates = allTabs.filter((tab) => {
        if (!tab.url) return false;
        if (tab.url.startsWith(extensionOrigin)) return false;
        let parsed;
        try { parsed = new URL(tab.url); } catch (_) { return false; }
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    });

    if (candidates.length === 0) return null;

    // Prefer tab.lastAccessed (Chrome 121+, "tabs" permission).
    // Defensive: only trust it when it is a finite number greater than 0.
    const hasLastAccessed = candidates.some(
        (t) => typeof t.lastAccessed === "number" && t.lastAccessed > 0
    );

    if (hasLastAccessed) {
        candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    } else {
        // Fallback: active tabs in any window beat inactive ones; otherwise
        // preserve the order Chrome returned (roughly window/tab-index order).
        candidates.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    }

    return candidates[0];
};


/**
 * Query the background service worker for all classified cookies for the
 * domain the user was most recently browsing before opening the NL Prefs page.
 *
 * Queries ALL tabs across all windows, filters out CookieBlock's own extension
 * pages, then picks the best remaining candidate via tab.lastAccessed (Chrome
 * 121+) with an active:true fallback for older Chrome versions.
 *
 * Mirrors the sendMessage pattern used in cookieblock_options.js:468-479:
 * the native callback API is wrapped in a Promise so callers can await it.
 *
 * @returns {Promise<Array<{name:string, category:string, current_label:number}>>}
 *          Resolves to an array of cookie summaries for the best-candidate site,
 *          or [] if no suitable tab is found, cblk_hconsent is disabled, or the
 *          background DB is not yet open (all silent/expected states).
 */
const getCurrentSiteCookies = function() {
    return new Promise((resolve) => {
        // Query every tab across every window — no active/window filter, because
        // this page is itself the active tab in its own window.
        chrome.tabs.query({}, (allTabs) => {
            if (chrome.runtime.lastError) {
                console.warn("[CookieBlock NL Prefs] tabs.query failed:", chrome.runtime.lastError.message);
                resolve([]);
                return;
            }

            const tab = _findBestWebsiteTab(allTabs || []);
            if (!tab) {
                // No suitable website tab open — acceptable degraded state.
                resolve([]);
                return;
            }

            let tabUrl;
            try {
                tabUrl = new URL(tab.url);
            } catch (_) {
                resolve([]);
                return;
            }

            // Protocol guard (already checked in _findBestWebsiteTab, but be
            // explicit here so this function is self-contained and auditable).
            if (tabUrl.protocol !== "http:" && tabUrl.protocol !== "https:") {
                resolve([]);
                return;
            }

            const domain = tabUrl.hostname;

            chrome.runtime.sendMessage({ "get_site_cookies": domain }, (msg) => {
                if (chrome.runtime.lastError) {
                    console.error("[CookieBlock NL Prefs] get_site_cookies failed:",
                                  chrome.runtime.lastError.message);
                    resolve([]);
                    return;
                }
                resolve(Array.isArray(msg && msg.response) ? msg.response : []);
            });
        });
    });
};
