import { describe, it, expect } from 'vitest'
import { routeOf, parseLicenceLink } from '../src/routes.js'

const FRAG = 'invite_tok.family-1234.AAAA'

describe('routeOf', () => {
  it('the app for / and any unknown path', () => {
    expect(routeOf('/', '', '')).toEqual({ page: 'app' })
    expect(routeOf('/index.html', '#x', '?a=1')).toEqual({ page: 'app' })
    expect(routeOf('/joinx', `#${FRAG}`, '')).toEqual({ page: 'app' })
  })

  it('/join carries the fragment as the invite (parsed later, so a bad one can be explained)', () => {
    expect(routeOf('/join', `#${FRAG}`, '')).toEqual({ page: 'join', invite: FRAG })
    expect(routeOf('/join/', `#${FRAG}`, '')).toEqual({ page: 'join', invite: FRAG })
    expect(routeOf('/join', '', '')).toEqual({ page: 'join', invite: '' })
  })

  it('/unlock reads session_id from the query', () => {
    expect(routeOf('/unlock', '', '?session_id=cs_test_123')).toEqual({ page: 'unlock', sessionId: 'cs_test_123' })
    expect(routeOf('/unlock', '', '')).toEqual({ page: 'unlock', sessionId: '' })
  })

  it('/licence carries the fragment as the link token', () => {
    expect(routeOf('/licence', '#tok_abc-123', '')).toEqual({ page: 'licence', linkToken: 'tok_abc-123' })
    expect(routeOf('/licence', '', '')).toEqual({ page: 'licence', linkToken: '' })
  })
})

describe('parseLicenceLink', () => {
  const tok = 'A'.repeat(43)
  it('accepts the full link, its fragment or the bare token', () => {
    expect(parseLicenceLink(`https://ar.example/licence#${tok}`)).toBe(tok)
    expect(parseLicenceLink(`#${tok}`)).toBe(tok)
    expect(parseLicenceLink(`  ${tok}\n`)).toBe(tok)
  })
  it('rejects anything else', () => {
    for (const bad of ['', 'https://ar.example/licence', 'short', `${tok}!`]) expect(() => parseLicenceLink(bad)).toThrow('bad-link')
  })
})
