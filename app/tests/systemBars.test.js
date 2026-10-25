import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const manifest = JSON.parse(read('../public/manifest.webmanifest'))
const css = read('../src/styles.css')

const lum = (hex) => {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((h) => {
    const c = parseInt(h, 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }

describe('Android system navigation bar', () => {
  // Chrome paints the installed app's navigation bar with one fixed manifest colour, while the
  // system draws its buttons white (dark theme) or near-black (light theme): the colour must work with both.
  it('manifest colours keep both white and dark system buttons visible', () => {
    for (const c of [manifest.background_color, manifest.theme_color]) {
      expect(contrast(c, '#ffffff')).toBeGreaterThanOrEqual(3)
      expect(contrast(c, '#1f1f1f')).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('hidden elements', () => {
  it('a global [hidden] rule beats component display rules', () => {
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/)
  })
})

describe('bottom bar over the tiles', () => {
  // Tile layers (pick z-index 2, open 3) must stay inside the tile, or a tile scrolled under
  // the fixed bar takes the taps meant for its buttons.
  it('tiles keep their layers to themselves and the bar sits above them', () => {
    expect(css).toMatch(/\.item \{[^}]*isolation: isolate/)
    expect(css).toMatch(/\.bar \{[^}]*z-index: 4/)
  })
})

describe('focus ring inside the scrolling category list', () => {
  // overflow clips outlines: the list needs room for the 3px ring at its 2px offset.
  it('the list keeps 5px of padding around its rows', () => {
    expect(css).toMatch(/:focus-visible \{ outline: 3px solid var\(--accent-strong\); outline-offset: 2px; \}/)
    expect(css).toMatch(/dialog \.catlist \{[^}]*padding: 5px;[^}]*overflow-y: auto/)
  })
})
