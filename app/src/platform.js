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
