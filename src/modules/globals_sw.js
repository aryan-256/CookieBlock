//-------------------------------------------------------------------------------
/*
Copyright (C) 2021-2022 Dino Bollinger, ETH Zürich, Information Security Group

This file is part of CookieBlock.

Released under the MIT License, see included LICENSE file.
*/
//-------------------------------------------------------------------------------
//
// globals_sw.js — Service Worker-safe subset of globals.js
//
// What was REMOVED vs the original globals.js:
//   • getExtensionFile()      — used XMLHttpRequest; not available in SW
//   • setStaticLocaleText()   — uses document.getElementById; not available in SW
//   • Top-level defaultConfig auto-load via XHR
//
// What was ADDED:
//   • fetchExtensionJSON()    — fetch()-based replacement for getExtensionFile
//
// defaultConfig is declared here as `undefined` and is populated by
// ensureInitialized() in cookieblock_sw.js before any storage operations run.
//
// UI pages (options, popup) continue to use the original globals.js unchanged.
//-------------------------------------------------------------------------------


// CookieBlock icon in color, default
const defaultIcon = {
    "path": {
        "16": "/icons/cookieblock-16.png",
        "32": "/icons/cookieblock-32.png",
        "48": "/icons/cookieblock-48.png",
        "64": "/icons/cookieblock-64.png",
        "96": "/icons/cookieblock-96.png",
        "128": "/icons/cookieblock-128.png"
    }
};

// CookieBlock icon in grayscale, when deactivated
const grayScaleIcon = {
    "path": {
        "16": "/icons/gs-cookieblock-16.png",
        "32": "/icons/gs-cookieblock-32.png",
        "48": "/icons/gs-cookieblock-48.png",
        "64": "/icons/gs-cookieblock-64.png",
        "96": "/icons/gs-cookieblock-96.png",
        "128": "/icons/gs-cookieblock-128.png"
    }
};

const enableExtraOptions = false;


/**
 * Fetch a JSON resource from a local extension URL.
 * This is the Service Worker replacement for the XHR-based getExtensionFile().
 *
 * For extension-bundled files, pass chrome.runtime.getURL("/path/to/file.json").
 * For user-supplied remote URLs (e.g. user known-cookies lists) the same fetch()
 * works because host_permissions grants access to <all_urls>.
 *
 * @param {String} url  Full URL to the resource.
 * @returns {Promise<any>} Parsed JSON value.
 * @throws {Error} If the network request fails or the response is not OK.
 */
const fetchExtensionJSON = async function(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(
            `fetchExtensionJSON: failed to load "${url}" ` +
            `(HTTP ${response.status} ${response.statusText})`
        );
    }
    return response.json();
};


/**
 * Helper used to transform the chrome.storage.get callback into an async function.
 * @param {Object} stType  chrome.storage.local or chrome.storage.sync.
 * @param {String} key     Key of the storage to retrieve.
 * @returns {Promise<any>} A promise which will eventually contain the retrieved value.
 */
function chromeWorkaround(stType, key) {
    return new Promise((resolve, reject) => {
        stType.get([key], function(result) {
            if (chrome.runtime.lastError) {
                reject("Failed to retrieve data from storage: " + chrome.runtime.lastError);
            } else {
                resolve(result[key]);
            }
        });
    });
}


/**
 * Helper function for storing content in sync or local storage.
 * @param {*} newValue     New value to store.
 * @param {Object} stType  chrome.storage.sync or chrome.storage.local.
 * @param {String} key     Unique storage key identifier.
 * @param {Boolean} override If true, will override the existing value.
 */
const setStorageValue = async function(newValue, stType, key, override = true) {
    let obj;
    if (override) {
        obj = {}; obj[key] = newValue;
        stType.set(obj);
    } else {
        try {
            let cValue = await chromeWorkaround(stType, key);
            if (cValue === undefined) {
                obj = {}; obj[key] = newValue;
                stType.set(obj);
            }
        } catch(err) {
            throw err;
        }
    }
};


/**
 * Helper function for retrieving content from sync or local storage.
 * Falls back to defaultConfig[key] if the key has not yet been written to storage.
 * NOTE: defaultConfig must be populated by ensureInitialized() before this is called.
 *
 * @param {Object} stType  chrome.storage.sync or chrome.storage.local.
 * @param {String} key     Storage key.
 * @returns {Promise<any>} Stored value, or default from defaultConfig.
 */
const getStorageValue = async function(stType, key) {
    let value = undefined;
    try {
        value = await chromeWorkaround(stType, key);
    } catch(err) {
        console.error("Failed to access storage! Error: " + err.message);
    }

    if (value === undefined) {
        console.warn(`Warning: Value '${key}' not found in storage!`);
        if (defaultConfig !== undefined) {
            if (Array.isArray(defaultConfig[key])) {
                value = [...defaultConfig[key]];
            } else {
                value = defaultConfig[key];
            }
            setStorageValue(value, stType, key, false);
        } else {
            // defaultConfig not loaded yet — ensureInitialized() must be awaited
            // before any storage helpers are called.
            console.error(
                `getStorageValue: defaultConfig is not yet loaded; ` +
                `cannot provide fallback for '${key}'. ` +
                `Ensure ensureInitialized() is awaited before calling this function.`
            );
        }
    }
    return value;
};


/**
 * Remove URL encoding from the string.
 * @param  {String} str   Maybe URL-encoded string.
 * @return {String}       Decoded string.
 */
const escapeString = function(str) {
    if (typeof str != "string") {
        str = String(str);
    }
    return unescape(encodeURIComponent(str));
};


/**
 * Takes a URL or a domain string and transforms it into a uniform format.
 * Examples: {"www.example.com", "https://example.com/", ".example.com"} --> "example.com"
 * @param {String} domain  Domain to clean and bring into uniform format.
 * @return {String}        Cleaned domain string.
 */
const urlToUniformDomain = function(url) {
    if (url === null) {
        return null;
    }
    let new_url = url.trim();
    new_url = new_url.replace(/^\./, ""); // cookies can start like .www.example.com
    new_url = new_url.replace(/^http(s)?:\/\//, "");
    new_url = new_url.replace(/^www([0-9])?/, "");
    new_url = new_url.replace(/^\./, "");
    new_url = new_url.replace(/\/.*$/, "");
    return new_url;
};


/**
 * Remove leading dot / protocol / trailing path from a domain string,
 * but unlike urlToUniformDomain does NOT strip the "www" subdomain.
 * @param {String} url  Domain or URL to clean.
 * @return {String}     Cleaned domain.
 */
const domainRemoveNoise = function(url) {
    if (url === null) {
        return null;
    }
    let new_url = url.trim();
    new_url = new_url.replace(/^\./, "");
    new_url = new_url.replace(/^http(s)?:\/\//, "");
    new_url = new_url.replace(/^\./, "");
    new_url = new_url.replace(/\/.*$/, "");
    return new_url;
};


/**
 * Transforms the given domain or URL into a uniform representation.
 * @param {String} domainOrURL  Domain or URL to transform.
 * @return {String}             Transformed domain.
 */
const cleanDomain = (domainOrURL) => {
    try {
        return urlToUniformDomain(new URL(domainOrURL).hostname);
    } catch(error) {
        return urlToUniformDomain(domainOrURL);
    }
};


/**
 * Given a cookie expiration date, compute the expiry time in seconds
 * starting from the current time and date.
 * @param  {Object} cookie  Cookie object with "session" and "expirationDate".
 * @return {Number}         Expiration time in seconds. Zero if session cookie.
 */
const datetimeToExpiry = function(cookie) {
    let curTS = Math.floor(Date.now() / 1000);
    return cookie.session ? 0 : cookie.expirationDate - curTS;
};


/**
 * Transform class index to human-readable category name.
 * @param {Number} idx  Class label index.
 * @returns {String}    Human-readable string.
 */
const classIndexToString = (idx) => {
    switch(idx) {
        case -1: return "Unknown";
        case 0:  return "Necessary";
        case 1:  return "Functionality";
        case 2:  return "Analytical";
        case 3:  return "Advertising";
        case 4:  return "Uncategorized";
        case 5:  return "Social Media";
        default: return "Invalid Category Index";
    }
};


// Default configuration object.
// Declared here as `undefined`; populated by ensureInitialized() in cookieblock_sw.js.
// DO NOT auto-load here — initialization order is controlled by the SW entry point.
var defaultConfig = undefined;
