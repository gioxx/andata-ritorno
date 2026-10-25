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

export const currentPlatform = () => platformOf({ ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints || 0 })

export const isStandalone = () =>
  (window.matchMedia?.('(display-mode: standalone)').matches ?? false) || navigator.standalone === true
