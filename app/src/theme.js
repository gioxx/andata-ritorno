// Theme preference lives in localStorage['ar-theme']; absent = follow the system.
const KEY = 'ar-theme';

/** @returns {'auto'|'light'|'dark'} */
export function getTheme() {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {}
  return 'auto';
}

/** @param {'auto'|'light'|'dark'} choice */
export function setTheme(choice) {
  const root = document.documentElement;
  // Storage can throw (private mode, blocked data); the attribute still applies for this session
  try {
    if (choice === 'light' || choice === 'dark') localStorage.setItem(KEY, choice);
    else localStorage.removeItem(KEY);
  } catch {}
  if (choice === 'light' || choice === 'dark') root.dataset.theme = choice;
  else delete root.dataset.theme;
}
