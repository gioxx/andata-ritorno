// Classic script in <head>: applies the saved theme and the language before first paint (no flash).
// Keep in sync with src/theme.js and src/i18n.js. 'auto' theme (no attribute) follows the system.
try {
  var th = localStorage.getItem('ar-theme')
  if (th === 'light' || th === 'dark') document.documentElement.dataset.theme = th
} catch (e) {}
try {
  var l = localStorage.getItem('ar-lang')
  if (l !== 'it' && l !== 'en') l = String(navigator.language || '').toLowerCase().indexOf('it') === 0 ? 'it' : 'en'
  document.documentElement.lang = l
} catch (e) {}
