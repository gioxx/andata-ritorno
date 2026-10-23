import { describe, it, expect } from 'vitest'
import { backupInfoLine, persistLine, mappingRows, importErrorMessage, removeTodo, blockedTitle } from '../src/ui/model.js'

describe('ui model', () => {
  it('backup info singular/plural and mai', () => {
    expect(backupInfoLine(1, null)).toBe('1 capo · ultimo backup: mai')
    expect(backupInfoLine(0, null)).toBe('0 capi · ultimo backup: mai')
    const iso = '2026-10-23T10:00:00.000Z'
    expect(backupInfoLine(3, iso)).toBe(`3 capi · ultimo backup: ${new Date(iso).toLocaleString('it-IT')}`)
  })
  it('persist line', () => {
    expect(persistLine(true)).toBe('Memoria protetta ✓')
    expect(persistLine(false)).toBe('Memoria non protetta: fai backup spesso')
    expect(persistLine(null)).toBe('')
  })
  it('mapping rows: new tab first, then existing', () => {
    const rows = mappingRows(['nido', 'materna'], [{ id: 't1', name: 'Sofia' }])
    expect(rows[0].options).toEqual([{ value: 'new', label: 'Nuova scheda "Nido"' }, { value: 't1', label: 'Sofia' }])
    expect(rows[1].options[0].label).toBe('Nuova scheda "Materna"')
  })
  it('error copy', () => {
    expect(importErrorMessage(new Error('quota'))).toBe('Memoria del telefono piena: impossibile importare. Libera spazio e riprova.')
    expect(importErrorMessage(new Error('verify-failed'))).toContain('Verifica non riuscita')
    expect(importErrorMessage(new Error('bad-file'))).toBe('File non valido')
    expect(importErrorMessage(new SyntaxError('x'))).toBe('File non valido')
    expect(importErrorMessage(new Error('boom'))).toBeNull()
  })
  it('removeTodo removes by itemId+reason only', () => {
    const a = { itemId: 'a', reason: 'r1' }, b = { itemId: 'a', reason: 'r2' }
    expect(removeTodo([a, b], a)).toEqual([b])
  })
  it('blocked title', () => {
    expect(blockedTitle(1)).toBe('1 capo non si può importare')
    expect(blockedTitle(4)).toBe('4 capi non si possono importare')
  })
})
