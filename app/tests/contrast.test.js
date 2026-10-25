// WCAG contrast of the token pairs the stylesheet actually uses, read from styles.css so a
// palette change cannot silently break them. 4.5 = normal text, 3 = UI parts / large text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const tokens = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,6})\b/g)].map((m) => [m[1], m[2]]))
const light = tokens(css.match(/:root \{([^}]*)\}/)[1])
const dark = { ...light, ...tokens(css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)[1]) }
// The system-preference block must carry the same dark values as the forced-dark one.
const darkAuto = { ...light, ...tokens(css.match(/prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)[1]) }

const rgb = (h) => { const x = h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h; return [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255) }
const lum = (h) => { const [r, g, b] = rgb(h).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
export const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05) }

// [foreground token, background token, minimum, where it is used]
const PAIRS = [
  ['fg', 'bg', 4.5, 'body text'],
  ['fg', 'chip', 4.5, 'text on chips, unsaved banner'],
  ['fg', 'school', 4.5, 'section titles'],
  ['fg', 'home', 4.5, 'section titles'],
  ['fg', 'tile', 4.5, 'dialog inputs'],
  ['muted', 'bg', 4.5, 'hints, notes, ghost buttons'],
  ['muted', 'surface', 4.5, 'dialog/drawer secondary text'],
  ['muted', 'chip', 4.5, 'inactive tab and category pills, counts'],
  ['muted', 'badge', 4.5, 'item counts in the category manager'],
  ['muted', 'school', 4.5, 'empty-section text'],
  ['muted', 'home', 4.5, 'empty-section text'],
  ['muted', 'tile', 4.5, 'input placeholders'],
  ['bg', 'accent-strong', 4.5, 'text on active pills, primary buttons, badges'],
  ['accent-strong', 'surface', 4.5, 'link-style button in dialogs'],
  ['danger', 'surface', 4.5, 'delete buttons'],
  ['accent-strong', 'bg', 3, 'focus ring / selection outline on the page'],
  ['accent-strong', 'chip', 3, 'focus ring on chips'],
  ['accent-strong', 'school', 3, 'focus ring / selection outline in sections'],
  ['accent-strong', 'home', 3, 'focus ring / selection outline in sections'],
  ['accent-strong', 'surface', 3, 'focus ring on dialogs and drawer'],
  ['accent-strong', 'tile', 3, 'focus ring on inputs and tiles'],
  ['accent', 'holder', 3, 'menu icons (UI part)'],
  ['muted', 'bg', 3, 'dashed/outlined chip borders (UI part)'],
]

it('the system-dark block carries exactly the forced-dark values', () => {
  expect(darkAuto).toEqual(dark)
})

describe.each([['light', light], ['dark', dark], ['dark (system preference)', darkAuto]])('%s theme', (_name, th) => {
  it.each(PAIRS)('%s on %s >= %s (%s)', (fg, bg, min) => {
    expect(ratio(th[fg], th[bg])).toBeGreaterThanOrEqual(min)
  })
})

it('light accent-strong is the darker accent', () => {
  expect(lum(light['accent-strong'])).toBeLessThan(lum(light.accent))
})
