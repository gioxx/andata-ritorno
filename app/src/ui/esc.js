// Escape user text for innerHTML. Its own module so dialogs, model and render share one copy
// without importing each other.
/** @param {unknown} s */
export const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
