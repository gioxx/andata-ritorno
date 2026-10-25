import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDb } from '../src/db.js'
import { store, load, addCategory, renameCategory, reorderCategories, removeCategory, addDefaultCategories } from '../src/store.js'
import { DEFAULT_CATEGORIES, categoryName, missingDefaults } from '../src/categories.js'
import { setLang } from '../src/i18n.js'

let db
beforeEach(async () => {
  db = await openDb('ar-cat-' + crypto.randomUUID())
  await load(db)
})
afterEach(() => setLang('it'))

describe('default categories', () => {
  it('addDefaultCategories adds the 9 defaults once', async () => {
    setLang('it')
    await addDefaultCategories()
    expect(store.categories.map((c) => c.id)).toEqual(DEFAULT_CATEGORIES.map((d) => d.id))
    expect(store.categories).toHaveLength(9)
    expect(store.categories[0]).toMatchObject({ id: 'default-body', name: 'Body', nameKey: 'category.default.body', order: 0 })
    expect(store.categories[8].id).toBe('default-accessories')
    expect(store.unsaved).toBe(1)

    await addDefaultCategories()
    expect(store.categories).toHaveLength(9)
    expect(store.unsaved).toBe(1) // nothing missing = nothing changed

    await removeCategory('default-socks')
    expect(missingDefaults(store.categories).map((d) => d.id)).toEqual(['default-socks'])
    await addDefaultCategories()
    expect(store.categories).toHaveLength(9)
    expect(store.categories.at(-1).id).toBe('default-socks') // order after existing
    await load(db)
    expect(store.categories).toHaveLength(9)
  })

  it('renamed default keeps its name across languages', async () => {
    setLang('it')
    await addDefaultCategories()
    await renameCategory('default-body', ' Bodini ')
    const by = (id) => store.categories.find((c) => c.id === id)
    expect(by('default-body').nameKey).toBeUndefined()
    setLang('en')
    expect(categoryName(by('default-body'))).toBe('Bodini')
    expect(categoryName(by('default-socks'))).toBe('Socks')
    setLang('it')
    expect(categoryName(by('default-socks'))).toBe('Calze')
  })
})

describe('category actions', () => {
  it('add, rename, reorder, remove each count as one change', async () => {
    await addCategory(' Costumi ')
    await addCategory('Scarpe')
    expect(store.categories.map((c) => [c.name, c.order])).toEqual([['Costumi', 0], ['Scarpe', 1]])
    await expect(addCategory('  ')).rejects.toThrow('empty-name')
    await expect(renameCategory('nope', 'x')).rejects.toThrow('not-found')
    const [a, b] = store.categories.map((c) => c.id)
    await reorderCategories([b, a])
    expect(store.categories.map((c) => c.id)).toEqual([b, a])
    await removeCategory(a)
    expect(store.categories.map((c) => c.id)).toEqual([b])
    expect(store.unsaved).toBe(4)
    await load(db)
    expect(store.categories.map((c) => c.id)).toEqual([b])
  })
})
