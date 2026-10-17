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
            { role: "user",   content: userText }
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

// ── "Discard" click handler ───────────────────────────────────────────────────

nlprefsDiscardBtn.addEventListener("click", () => {
    currentProposal = null;
    hide(nlprefsResults);
    clearFeedback();
    nlprefsApplyBtn.disabled = true;
    nlprefsGenBtn.disabled   = false;
    // Leave the textarea contents intact so the user can adjust and retry
});
