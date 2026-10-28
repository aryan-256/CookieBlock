//-------------------------------------------------------------------------------
/*
Copyright (C) 2021-2022 Dino Bollinger, ETH Zürich, Information Security Group

This file is part of CookieBlock.

Released under the MIT License, see included LICENSE file.
*/
//-------------------------------------------------------------------------------

// ── DOM element references ────────────────────────────────────────────────────

const nlprefsTextarea = document.getElementById("nlprefs-textarea");
const nlprefsSetBtn   = document.getElementById("nlprefs-set-btn");
const nlprefsAskBtn   = document.getElementById("nlprefs-ask-btn");
const nlprefsLoading  = document.getElementById("nlprefs-loading");
const nlprefsLog      = document.getElementById("nlprefs-log");

// ── Constants ─────────────────────────────────────────────────────────────────

const OLLAMA_URL  = "http://localhost:11434/api/chat";
const MODEL_NAME  = "llama3.2:latest";

/**
 * System prompt for the "Set Preferences" mode.
 * The model must return structured JSON with exactly the schema specified in
 * the request's `format` field.
 */
const SYSTEM_PROMPT = "You configure a browser cookie-consent tool. Decide which cookie categories to ALLOW (true) or BLOCK (false):\n- functionality: preferences, language, UI settings, convenience features\n- analytics: usage statistics and site performance measurement\n- advertising: ad targeting, personalized ads, cross-site tracking\nStrictly-necessary cookies are always allowed; do not output them.\n\nThe user's current CookieBlock settings may be provided as context. They are for reference only — always derive your output solely from what the user is now asking for; do not default to preserving the current settings.\n\nEvaluate each of the three categories independently based on what the user actually said. Do not assume a category is blocked just because another category was mentioned or blocked.\n\nRules:\n1. \"Maximum privacy\", \"block everything\", \"block all\", or any request to keep only what's required/necessary/essential means all three are false.\n2. If the user wants personalized or relevant ads, advertising is true. This does not by itself say anything about functionality or analytics.\n3. If the user says they accept or don't mind a category, that category is true.\n4. Conservative default: when the user's language is ambiguous about which specific categories to allow (e.g. \"allow what doesn't violate my privacy\", \"keep me safe\", \"minimize tracking\"), block any category that is not clearly and explicitly permitted. Do not infer permission from vague positive framing — genuine uncertainty about a category means block it, not allow it. This is a deliberate product default for a privacy-focused tool.\n5. If the request is not about cookies or privacy, set understood=false and all three false.\n6. If the request contradicts itself, set understood=false and describe the conflict in the explanation.\n7. The explanation must be 1–2 sentences and must reflect actual per-category reasoning: name why each blocked category was blocked and each allowed category was allowed. When the conservative default (rule 4) was applied, acknowledge that the request was ambiguous and state which categories were blocked as a result — do not use a single blanket phrase that treats all categories as interchangeable.";

/**
 * System prompt for the "Ask" mode.
 * Plain-text, no structured output.  The model should draw on the site-cookie
 * context prepended to the user message when available, and say plainly when
 * it doesn't have enough information rather than guessing.
 */
const EXPLAIN_SYSTEM_PROMPT = "You are a privacy assistant embedded in the CookieBlock browser extension. Answer the user's question about cookies, cookie categories, or web privacy in clear, plain language that a non-technical person can understand. When a list of cookies currently set on the user's site is provided at the top of the message, use it to give a specific, relevant answer. Note: when a category is blocked in the user's current settings, CookieBlock prevents new or re-set cookies in that category from being kept, but it does not immediately delete cookies already stored in the browser. If asked about cookies that are both currently present and in a blocked category, explain both facts clearly: the cookie is already present in storage, but future additions or updates in that category will be blocked; existing ones remain until they expire or are re-set. If you do not have enough information to answer accurately, say so plainly — do not guess or fabricate cookie purposes. Keep answers concise: 1–3 short paragraphs at most.\n\nCRITICAL — no cookie data available: If the message contains the line \"No cookie data is currently available for this site.\", it means CookieBlock has no recorded cookies for the active site — either no website tab is open, or cookie history collection is disabled. In this case you MUST tell the user that you have no cookie data to work from, and suggest they open a website or check that cookie history is enabled in CookieBlock's settings. You MUST NOT invent, guess, or list any cookie names, values, or purposes as examples or illustrations — not even generically plausible ones such as session_id, language, theme, _ga, or similar. Fabricated cookie names are never an acceptable substitute for real data, even if the user's question implies they expect a specific answer. This rule is absolute and overrides any instruction to be helpful or to provide examples.";

// ── Helper: show/hide a DOM element ──────────────────────────────────────────

function show(el) { el.hidden = false; }
function hide(el) { el.hidden = true; }

// ── Helper: disable / enable both submit buttons ──────────────────────────────

function setBusy(busy) {
    nlprefsSetBtn.disabled = busy;
    nlprefsAskBtn.disabled = busy;
    if (busy) {
        show(nlprefsLoading);
    } else {
        hide(nlprefsLoading);
    }
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Defensively validate an object returned by the model in Set Preferences mode.
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

// ── Helper: build an ON/OFF badge element ─────────────────────────────────────

/**
 * Create a badge <span> showing ON (green) or OFF (red).
 * @param {boolean} value
 * @returns {HTMLSpanElement}
 */
function makeBadge(value) {
    const span = document.createElement("span");
    span.className   = "nlprefs-badge " + (value ? "on" : "off");
    span.textContent = value ? "ON" : "OFF";
    return span;
}

// ── Chat log helpers ──────────────────────────────────────────────────────────

/**
 * Append a user message bubble to the chat log.
 * @param {string} labelText  e.g. "You requested:" / "You asked:"
 * @param {string} bodyText   The raw text the user typed.
 * @returns {HTMLElement}  The outer entry div (used to attach the assistant bubble).
 */
function appendUserBubble(labelText, bodyText) {
    const entry = document.createElement("div");
    entry.className = "nlp-entry";

    const userBubble = document.createElement("div");
    userBubble.className = "nlp-user-bubble";

    const label = document.createElement("span");
    label.className   = "nlp-user-label";
    label.textContent = labelText;

    const text = document.createElement("div");
    text.className   = "nlp-user-text";
    text.textContent = bodyText;

    userBubble.appendChild(label);
    userBubble.appendChild(text);
    entry.appendChild(userBubble);
    nlprefsLog.appendChild(entry);

    // Scroll newly appended message into view
    entry.scrollIntoView({ behavior: "smooth", block: "nearest" });

    return entry;
}

/**
 * Append an assistant bubble (of any type) to an existing entry element.
 * @param {HTMLElement} entry       The entry div returned by appendUserBubble.
 * @param {HTMLElement} bubbleBody  The element to place inside the bubble.
 * @param {boolean}     isError     If true, adds the nlp-error class.
 * @returns {HTMLElement}  The assistant bubble element.
 */
function appendAssistantBubble(entry, bubbleBody, isError = false) {
    const bubble = document.createElement("div");
    bubble.className = "nlp-assistant-bubble" + (isError ? " nlp-error" : "");
    bubble.appendChild(bubbleBody);
    entry.appendChild(bubble);
    bubble.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return bubble;
}

/**
 * Append a plain error message as an assistant bubble.
 */
function appendErrorBubble(entry, msg) {
    const p = document.createElement("p");
    p.textContent = msg;
    appendAssistantBubble(entry, p, /* isError= */ true);
}

// ── Site-cookie context helpers ───────────────────────────────────────────────

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

/**
 * Fetch classified cookies from the service worker and build a context block
 * to prepend to the user's prompt.
 *
 * Shared by both "Set Preferences" and "Ask" handlers.
 *
 * Deduplication by (name, category): IndexedDB records can exist for the same
 * cookie name across different paths (e.g. '/' vs '/sub') or subdomain scopes.
 * Deduplicating prevents redundant lines from crowding the prompt context.
 *
 * Cap at 30: 111+ cookies would overwhelm a 3B model's context budget and
 * attention window.  30 entries provide representative site context without
 * token bloat.
 *
 * @param {string} userText  The raw text the user typed.
 * @returns {Promise<string>}  The user prompt string, with cookie context prepended
 *                             if data is available, or just userText if not.
 */
const buildUserPrompt = async function(userText) {
    // ── 1. Read current policy state ─────────────────────────────────────────
    // Gracefully degrade if read fails or returns an unexpected value.
    // Policy array: [0]=Necessary (always on), [1]=Functionality,
    //               [2]=Analytics, [3]=Advertising
    const POLICY_LABELS = [null, "Functionality", "Analytics", "Advertising"];
    let policyLine = "";
    try {
        const policy = await getStorageValue(chrome.storage.sync, "cblk_userpolicy");
        if (Array.isArray(policy) && policy.length >= 4) {
            const parts = POLICY_LABELS
                .map((label, i) => label ? `${label}=${policy[i] ? "ALLOWED" : "BLOCKED"}` : null)
                .filter(Boolean);
            policyLine = `Current CookieBlock settings: ${parts.join(", ")}`;
        }
    } catch (err) {
        // Non-fatal — omit the policy line if storage read fails
        console.warn("[CookieBlock NL Prefs] Could not read cblk_userpolicy:", err);
    }

    // ── 2. Read site cookies ──────────────────────────────────────────────────
    let siteCookies = [];
    try {
        siteCookies = await getCurrentSiteCookies();
    } catch (err) {
        // Degrade gracefully — continue without site context
        console.warn("[CookieBlock NL Prefs] Could not retrieve site cookies:", err);
    }

    // ── 3. Assemble prompt ────────────────────────────────────────────────────
    const hasCookies = Array.isArray(siteCookies) && siteCookies.length > 0;

    const parts = [];

    if (policyLine) {
        parts.push(policyLine);
    }

    if (hasCookies) {
        // Deduplicate by (name, category) pair
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
            const MAX_CONTEXT_COOKIES = 30;
            const capped      = uniqueCookies.slice(0, MAX_CONTEXT_COOKIES);
            const cookieLines = capped.map((c) => `${c.name}: ${c.category}`).join("\n");
            parts.push(`Cookies currently set on this site:\n${cookieLines}`);
        } else {
            // siteCookies was non-empty but every entry was malformed — treat as absent.
            parts.push("No cookie data is currently available for this site.");
        }
    } else {
        // Empty array: no suitable website tab open, or no history data for the site.
        // Emit an explicit negative statement so the model has a concrete fact to
        // reason from, rather than an implicit absence it might paper over with
        // confabulated cookie names.
        parts.push("No cookie data is currently available for this site.");
    }

    parts.push(`User request: ${userText}`);
    return parts.join("\n\n");
};

// ── Apply a proposal to chrome.storage ───────────────────────────────────────

/**
 * Write a validated policy proposal to chrome.storage.sync.
 * @param {Object} proposal  A validated proposal object.
 */
const applyProposal = async function(proposal) {
    // Read the current policy first to avoid clobbering index 0 (necessary cookies)
    let policy = await getStorageValue(chrome.storage.sync, "cblk_userpolicy");

    // Index 0 is "necessary" — always true, never changed by NL prefs
    policy[0] = true;
    policy[1] = proposal.functionality;
    policy[2] = proposal.analytics;
    policy[3] = proposal.advertising;

    // Write back using the same pattern as cookieblock_options.js
    setStorageValue(policy, chrome.storage.sync, "cblk_userpolicy");
};

// ── "Set Preferences" handler ─────────────────────────────────────────────────

nlprefsSetBtn.addEventListener("click", async () => {
    const userText = nlprefsTextarea.value.trim();
    if (!userText) return;

    nlprefsTextarea.value = "";
    setBusy(true);

    // Append user message bubble immediately so the UI feels responsive
    const entry = appendUserBubble("You requested:", userText);

    let userPrompt;
    try {
        userPrompt = await buildUserPrompt(userText);
    } finally {
        // buildUserPrompt never throws, but guard defensively
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
        const response = await fetch(OLLAMA_URL, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(requestBody)
        });

        if (!response.ok) {
            appendErrorBubble(entry, `Could not reach the local AI model. Is it running? (HTTP ${response.status})`);
            return;
        }

        outerJson = await response.json();
    } catch (networkErr) {
        appendErrorBubble(entry, "Could not reach the local AI model. Is it running?");
        return;
    } finally {
        setBusy(false);
    }

    // Ollama returns structured output as a JSON *string* inside message.content
    const rawContent = outerJson?.message?.content;
    if (typeof rawContent !== "string") {
        appendErrorBubble(entry, "Could not generate a valid suggestion. Please try rephrasing.");
        return;
    }

    let proposal;
    try {
        proposal = JSON.parse(rawContent);
    } catch (parseErr) {
        appendErrorBubble(entry, "Could not generate a valid suggestion. Please try rephrasing.");
        return;
    }

    if (!isValidProposal(proposal)) {
        appendErrorBubble(entry, "Could not generate a valid suggestion. Please try rephrasing.");
        return;
    }

    // ── Build the policy bubble (badges + explanation + Apply/Discard) ────────

    const bubbleContent = document.createElement("div");

    // Badges grid
    const grid = document.createElement("div");
    grid.className = "nlp-policy-grid";

    const rows = [
        { label: "Functionality", value: proposal.functionality },
        { label: "Analytics",     value: proposal.analytics     },
        { label: "Advertising",   value: proposal.advertising   }
    ];
    for (const { label, value } of rows) {
        const row = document.createElement("div");
        row.className = "nlp-policy-row";

        const lbl = document.createElement("span");
        lbl.className   = "nlp-policy-label";
        lbl.textContent = label;

        row.appendChild(lbl);
        row.appendChild(makeBadge(value));
        grid.appendChild(row);
    }
    bubbleContent.appendChild(grid);

    // Explanation text — attached directly to the bubble, not floating outside
    const explanationEl = document.createElement("p");
    explanationEl.className = "nlp-explanation";

    if (!proposal.understood) {
        const uncertain = document.createElement("span");
        uncertain.className   = "nlp-uncertain-note";
        uncertain.textContent = "I wasn't fully sure I understood — here's my best guess: ";
        explanationEl.appendChild(uncertain);
    }

    // Safe: textContent used, not innerHTML
    explanationEl.appendChild(document.createTextNode(proposal.explanation.trim()));
    bubbleContent.appendChild(explanationEl);

    // Apply / Discard buttons — scoped to this specific proposal via closure.
    // Each message in the log has its own copy of `proposal`; clicking Apply on
    // an older entry only applies that entry's values, not any later proposal.
    const actionsEl = document.createElement("div");
    actionsEl.className = "nlp-policy-actions";

    const applyBtn   = document.createElement("button");
    applyBtn.className   = "nlp-apply-btn";
    applyBtn.textContent = "Apply";
    applyBtn.type        = "button";

    const discardBtn   = document.createElement("button");
    discardBtn.className   = "nlp-discard-btn";
    discardBtn.textContent = "Discard";
    discardBtn.type        = "button";

    // Track resolved state locally — no shared global needed
    let resolved = false;

    const resolveActions = (confirmedText) => {
        if (resolved) return;
        resolved = true;
        // Replace buttons with a status note
        actionsEl.replaceChildren();
        const note = document.createElement("span");
        note.className   = confirmedText ? "nlp-confirmed-note" : "nlp-resolved-note";
        note.textContent = confirmedText || "Discarded.";
        actionsEl.appendChild(note);
    };

    applyBtn.addEventListener("click", async () => {
        if (resolved) return;
        try {
            await applyProposal(proposal);
            resolveActions("✔ Preferences applied");
        } catch (err) {
            console.error("[CookieBlock NL Prefs] Apply failed:", err);
            resolveActions(null);
            // Show a small inline error note
            const errNote = document.createElement("span");
            errNote.className   = "nlp-resolved-note";
            errNote.textContent = "⚠ Failed to save. Please try again.";
            actionsEl.appendChild(errNote);
        }
    });

    discardBtn.addEventListener("click", () => {
        resolveActions(null);
    });

    actionsEl.appendChild(applyBtn);
    actionsEl.appendChild(discardBtn);
    bubbleContent.appendChild(actionsEl);

    appendAssistantBubble(entry, bubbleContent);
});

// ── "Ask" handler ─────────────────────────────────────────────────────────────

nlprefsAskBtn.addEventListener("click", async () => {
    const userText = nlprefsTextarea.value.trim();
    if (!userText) return;

    nlprefsTextarea.value = "";
    setBusy(true);

    const entry = appendUserBubble("You asked:", userText);

    let userPrompt;
    try {
        userPrompt = await buildUserPrompt(userText);
    } finally {
        // buildUserPrompt never throws, but guard defensively
    }

    // Ask mode: no `format` field — Ollama returns a plain chat completion.
    // The response shape is identical (outerJson.message.content) but the
    // content is a plain string, not JSON to parse.
    const requestBody = {
        model: MODEL_NAME,
        stream: false,
        options: { temperature: 0.3 },
        messages: [
            { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
            { role: "user",   content: userPrompt }
        ]
    };

    let outerJson;
    try {
        const response = await fetch(OLLAMA_URL, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(requestBody)
        });

        if (!response.ok) {
            appendErrorBubble(entry, `Could not reach the local AI model. Is it running? (HTTP ${response.status})`);
            return;
        }

        outerJson = await response.json();
    } catch (networkErr) {
        appendErrorBubble(entry, "Could not reach the local AI model. Is it running?");
        return;
    } finally {
        setBusy(false);
    }

    const answerText = outerJson?.message?.content;
    if (typeof answerText !== "string" || answerText.trim().length === 0) {
        appendErrorBubble(entry, "The AI returned an empty response. Please try again.");
        return;
    }

    // Render plain-text answer safely (textContent, never innerHTML)
    const answerEl = document.createElement("div");
    answerEl.className   = "nlp-answer-text";
    answerEl.textContent = answerText.trim();

    appendAssistantBubble(entry, answerEl);
});
