// Import flow: prepare (parse + plan, no writes) → commit (one tx) → verify from the DB.
import { loadAll, applyPlan, getMeta, getPhoto } from '../db.js'
import { buildPlan } from './merge.js'
import { parseV1, detectFormat } from './v1.js'
import { parseZip } from './zip.js'
import { t } from '../i18n.js'

/** @typedef {import('../types.js').Failure} Failure */
/** @typedef {import('../types.js').Incoming} Incoming */
/** @typedef {import('../types.js').ImportPlan} ImportPlan */
/** @typedef {{ added:number, updated:number, failed:number,
 *   perTab:Array<{ tabName:string, school:number, home:number }>, familyKit:string|null }} Summary */

/** Thrown when the file has invalid items and the user did not choose a partial import. */
export class ImportBlocked extends Error {
  /** @param {Failure[]} failures */
  constructor(failures) {
    super('import-blocked')
    this.name = 'ImportBlocked'
    this.failures = failures
  }
}

/**
 * @param {File} file
 * @param {{ childMap?:Record<string,string> }} [opts]  child -> tab id | 'new' (from the mapping dialog)
 * @returns {Promise<{ incoming:Incoming, plan:ImportPlan, needsMapping:string[] }>}
 */
export async function prepareImport(db, file, { childMap = {} } = {}) {
  const format = await detectFormat(file)
  if (format === 'v2') {
    const local = await loadAll(db)
    // Tab ids missing from both the file and the local DB become failures inside parseZip.
    const incoming = await parseZip(file, { localTabIds: local.tabs.map((t) => t.id) })
    return { incoming, plan: buildPlan(local, incoming), needsMapping: [] }
  }
  if (format !== 'v1') throw new Error('bad-file')
  const json = JSON.parse(await file.text())

  const local = await loadAll(db)
  const tabIds = new Set(local.tabs.map((t) => t.id))
  // A remembered mapping to a since-deleted tab must be asked again, not orphan items.
  const valid = (map, extra) => Object.fromEntries(
    Object.entries(map ?? {}).filter(([, id]) => tabIds.has(id) || id === extra),
  )
  const stored = valid(await getMeta(db, 'childMap'))
  const map = { ...stored, ...valid(childMap, 'new') }

  const incoming = await parseV1(json, { childMap: map, now: new Date().toISOString(), tabs: local.tabs })
  const children = [...new Set(json.items.map((i) => i?.child).filter((c) => typeof c === 'string' && c))]
  const needsMapping = local.tabs.length ? children.filter((c) => !(c in map)) : []
  const plan = buildPlan(local, incoming)
  plan.metaPut = [['childMap', { ...stored, ...incoming.childMap }]]
  return { incoming, plan, needsMapping }
}

/**
 * Write everything in one tx (or nothing), then re-read and check every planned item.
 * @param {{ incoming:Incoming, plan:ImportPlan }} prepared
 * @param {{ partial:boolean }} opts
 * @returns {Promise<Summary>}
 */
export async function commitImport(db, { incoming, plan }, { partial }) {
  const { failures } = incoming
  if (failures.length && !partial) throw new ImportBlocked(failures)

  const metaPut = [...(plan.metaPut ?? [])]
  if (failures.length) {
    // Same file imported twice must not list the same item twice.
    const ids = new Set(failures.map((f) => f.itemId).filter(Boolean))
    const todo = ((await getMeta(db, 'todo')) ?? []).filter((f) => !ids.has(f.itemId))
    metaPut.push(['todo', [...todo, ...failures]])
  }
  try {
    await applyPlan(db, { ...plan, metaPut })
  } catch (e) {
    if (e?.name === 'QuotaExceededError') throw new Error('quota')
    throw e
  }

  const { tabs, items } = await loadAll(db)
  const byId = new Map(items.map((i) => [i.id, i]))
  // Every valid item of the file (incl. ones skipped as unchanged) must be there with its photo.
  const fileIds = new Set(incoming.items.map((i) => i.id))
  const toCheck = new Set([...fileIds, ...plan.itemsPut.map((i) => i.id)])
  for (const id of toCheck) {
    const stored = byId.get(id)
    const blob = stored && (await getPhoto(db, stored.photoId))
    if (!(blob?.size > 0)) throw new Error('verify-failed')
  }
  if (items.filter((i) => fileIds.has(i.id)).length !== fileIds.size) throw new Error('verify-failed')

  // Counts as stored, for the file's items: what the user compares with the mockup.
  const perTab = []
  for (const tab of tabs) {
    const mine = items.filter((i) => i.tabId === tab.id && fileIds.has(i.id))
    if (!mine.length) continue
    const school = mine.filter((i) => i.location === 'school').length
    perTab.push({ tabName: tab.name, school, home: mine.length - school })
  }
  // A backup made in a family carries its recovery kit: the UI offers to restore the family.
  return { added: plan.added, updated: plan.updated, failed: failures.length, perTab, familyKit: incoming.familyKit ?? null }
}

/** @param {Summary} s */
export function formatSummary(s) {
  const parts = [t('import.summary.added', { n: s.added })]
  for (const x of s.perTab) parts.push(t('import.summary.tab', { tab: x.tabName, total: x.school + x.home, school: x.school, home: x.home }))
  if (s.updated > 0) parts.push(t('import.summary.updated', { n: s.updated }))
  if (s.failed > 0) parts.push(t('import.summary.failed', { n: s.failed }))
  return parts.join(' · ')
}
