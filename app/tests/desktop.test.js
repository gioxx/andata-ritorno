import { describe, it, expect } from 'vitest'
import { shouldShowDesktopGate } from '../src/ui/desktop.js'

const pc = { standalone: false, coarsePointer: false, finePointer: true, touchPoints: 0, width: 1440 }

describe('shouldShowDesktopGate', () => {
  it('shows on a computer with mouse and a wide window', () => {
    expect(shouldShowDesktopGate(pc, false)).toBe(true)
  })
  it('does not show once dismissed in this browser', () => {
    expect(shouldShowDesktopGate(pc, true)).toBe(false)
  })
  it('does not show on phones and tablets', () => {
    expect(shouldShowDesktopGate({ ...pc, coarsePointer: true, finePointer: false, touchPoints: 5, width: 390 }, false)).toBe(false)
    expect(shouldShowDesktopGate({ ...pc, coarsePointer: true, touchPoints: 10, width: 1180 }, false)).toBe(false)
  })
  it('does not show on touch laptops or narrow windows', () => {
    expect(shouldShowDesktopGate({ ...pc, touchPoints: 10 }, false)).toBe(false)
    expect(shouldShowDesktopGate({ ...pc, width: 700 }, false)).toBe(false)
  })
  it('does not show when the app is installed', () => {
    expect(shouldShowDesktopGate({ ...pc, standalone: true }, false)).toBe(false)
  })
})
