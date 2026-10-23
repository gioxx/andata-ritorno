import { describe, it, expect } from 'vitest'
import { backupInfoLine, persistLine, mappingRows, importErrorMessage, removeTodo, blockedTitle, failureParts, failureRow, confirmedChoice } from '../src/ui/model.js'

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
    expect(rows[0].label).toBe('Nido')
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
  it('removeTodo removes exactly the tapped index (id-less duplicates)', () => {
    const a = { label: 'x', reason: 'r' }, b = { label: 'x', reason: 'r' }
    const out = removeTodo([a, b], 1)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(a)
  })
  it('failure text maps places and skips empty parts', () => {
    expect(failureParts({ label: '', tabName: '', location: 'school', reason: 'foto' })).toEqual({ title: 'senza nome', detail: 'a scuola · foto' })
    expect(failureParts({ label: 'Giacca', tabName: 'Nido', location: 'nonna', reason: 'r' }).detail).toBe('Nido · nonna · r')
    expect(failureParts({ label: 'G', tabName: 'N', location: 'home', reason: 'r' }).detail).toBe('N · a casa · r')
    expect(failureRow({ label: '<b>', tabName: '', location: 'home', reason: 'r' }, '<i>x</i>')).toBe('<li><div><strong>&lt;b&gt;</strong><br><span>a casa · r</span></div><i>x</i></li>')
  })
  it('partial import choice needs a confirmed yes', () => {
    expect(confirmedChoice('secondary', () => false)).toBeUndefined()
    expect(confirmedChoice('secondary', () => true)).toBe('secondary')
    expect(confirmedChoice('ok', () => { throw new Error('no confirm') })).toBe('ok')
  })
  it('blocked title', () => {
    expect(blockedTitle(1)).toBe('1 capo non si può importare')
    expect(blockedTitle(4)).toBe('4 capi non si possono importare')
  })
})
