/**
 * i18n.js - Internationalization utility for Netflix Subtitles+ extension
 * Handles translation of static and dynamic content
 */

/**
 * Translate all elements with data-i18n attribute in the DOM
 */
function translateStaticContent() {
  const elements = document.querySelectorAll("[data-i18n]");
  elements.forEach((element) => {
    const messageKey = element.getAttribute("data-i18n");
    const translation = chrome.i18n.getMessage(messageKey);
    if (translation) {
      element.textContent = translation;
    }
  });
}

/**
 * Get a translated message by key
 * @param {string} messageKey - The message key from messages.json
 * @returns {string} The translated message
 */
function getMessage(messageKey) {
  return chrome.i18n.getMessage(messageKey) || "";
}

/**
 * Initialize i18n on page load
 */
document.addEventListener("DOMContentLoaded", () => {
  translateStaticContent();
});

// Export for use in other scripts if needed
if (typeof module !== "undefined" && module.exports) {
  module.exports = { translateStaticContent, getMessage };
}
