import { describe, expect, it } from 'vitest'
import { searchableCardName } from './cardDisplayName'

describe('searchableCardName', () => {
  it('combines the card name, set abbreviation, and collector number', () => {
    expect(searchableCardName({
      name: 'Charizard ex',
      number: '074',
      set_ref: { abbreviation: 'SVP' },
    })).toBe('Charizard ex (SVP 074)')
  })

  it('falls back to the set id and removes a duplicated number marker', () => {
    expect(searchableCardName({ name: 'Pikachu', number: '#25', set_id: 'base1' }))
      .toBe('Pikachu (BASE1 25)')
  })

  it('keeps the plain name when identifying metadata is incomplete', () => {
    expect(searchableCardName({ name: 'Custom card' })).toBe('Custom card')
  })
})
