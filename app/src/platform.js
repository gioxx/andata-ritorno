// Best-effort platform detection (install instructions, iOS-only warnings).

/** @returns {'ios'|'android'|'desktop'|'other'} */
export function platformOf({ ua = '', maxTouchPoints = 0 } = {}) {
  // iPadOS 13+ reports a Macintosh UA; only real touch screens tell it apart from a Mac.
  if (/iPhone|iPod|iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Windows|Macintosh|Linux|CrOS|X11/.test(ua)) return 'desktop'
  return 'other'
}

/** Dictionary keys of the "add to Home screen" steps for a platform. */
export function installSteps(platform) {
  if (platform === 'ios') return ['install.ios.1', 'install.ios.2', 'install.ios.3']
  if (platform === 'android') return ['install.android.1', 'install.android.2', 'install.android.3']
  return []
}

/** Dictionary keys of the "how to uninstall" steps for a platform. */
export function uninstallSteps(platform) {
  if (platform === 'ios') return ['uninstall.ios.1', 'uninstall.ios.2']
  if (platform === 'android') return ['uninstall.android.1', 'uninstall.android.2']
  return []
}

/**
 * Step lists to show for a platform: its own, or both when we cannot tell (desktop/other).
 * @param {string} platform @param {(p: string) => string[]} stepsOf installSteps or uninstallSteps
 * @returns {{platform: 'android'|'ios', keys: string[]}[]}
 */
export function stepGroups(platform, stepsOf) {
  const list = platform === 'ios' || platform === 'android' ? [platform] : ['android', 'ios']
  return list.map((p) => ({ platform: p, keys: stepsOf(p) }))
}

export const currentPlatform = () => platformOf({ ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints || 0 })

export const isStandalone = () =>
  (window.matchMedia?.('(display-mode: standalone)').matches ?? false) || navigator.standalone === true

/**
 * How to open a link meant for the browser. In the app installed from Chrome on Android, an
 * intent: URL aimed at Chrome shows the page in a browser tab with a close button back to the
 * app (the plain URL is the fallback when Chrome is missing). Elsewhere, a new window.
 * Only for pages outside the app's own origin: Android opens those inside the installed app.
 * @param {string} url absolute https URL
 * @param {{platform: string, standalone: boolean}} env
 * @returns {{url: string, intent: boolean}}
 */
export function externalTarget(url, { platform, standalone }) {
  const u = new URL(url)
  if (platform !== 'android' || !standalone || u.protocol !== 'https:') return { url, intent: false }
  const fallback = encodeURIComponent(url)
  return { url: `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fallback};end`, intent: true }
}

/** Open a page in the browser, outside the installed app when there is one. */
export function openExternal(url) {
  const target = externalTarget(url, { platform: currentPlatform(), standalone: isStandalone() })
  if (target.intent) location.assign(target.url)
  else window.open(target.url, '_blank', 'noopener')
}
