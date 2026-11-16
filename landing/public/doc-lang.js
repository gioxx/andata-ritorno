// Privacy policy and terms hold both languages, Italian first. Opened without an anchor, the page
// jumps to the English text for anyone whose browser (or the app, with ?lang=en) asks for English.
const asked = new URLSearchParams(location.search).get('lang')
const lang = asked || (navigator.language || '').slice(0, 2)
if (!location.hash && lang && lang !== 'it') document.getElementById('en')?.scrollIntoView()
