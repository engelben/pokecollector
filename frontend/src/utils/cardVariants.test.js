import { describe, expect, it } from 'vitest'
import { getOwnedVariants, getPrimaryVariant, groupCollectionByCard, sortRowsByVariant } from './cardVariants'

const row = (over = {}) => ({
  id: 1, card_id: 'sv01-003_en', card: { id: 'sv01-003_en', name: 'Card' },
  quantity: 1, condition: 'NM', variant: 'Normal', lang: 'en', purchase_price: null,
  ...over,
})

describe('getOwnedVariants', () => {
  it('returns one entry per distinct owned variant', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal' }),
      row({ id: 2, variant: 'Reverse Holo' }),
    ])
    expect(result).toEqual([
      { variant: 'Normal', quantity: 1 },
      { variant: 'Reverse Holo', quantity: 1 },
    ])
  })

  it('sums quantity across rows of the same variant with different conditions', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', condition: 'NM', quantity: 1 }),
      row({ id: 2, variant: 'Normal', condition: 'LP', quantity: 2 }),
    ])
    expect(result).toEqual([{ variant: 'Normal', quantity: 3 }])
  })

  it('orders variants canonically regardless of row order', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'First Edition' }),
      row({ id: 2, variant: 'Holo' }),
      row({ id: 3, variant: 'Normal' }),
    ])
    expect(result.map(entry => entry.variant)).toEqual(['Normal', 'Holo', 'First Edition'])
  })

  it('treats a missing variant as Normal', () => {
    expect(getOwnedVariants([row({ variant: null })])).toEqual([{ variant: 'Normal', quantity: 1 }])
  })

  it('returns an empty array for no rows', () => {
    expect(getOwnedVariants([])).toEqual([])
  })

  it('still returns a pill for a variant outside the four canonical prints', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal' }),
      row({ id: 2, variant: 'Promo' }),
    ])
    expect(result).toEqual([
      { variant: 'Normal', quantity: 1 },
      { variant: 'Promo', quantity: 1 },
    ])
  })

  it('sorts multiple unknown variants alphabetically after the canonical ones', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Zeta Promo' }),
      row({ id: 2, variant: 'Alpha Promo' }),
    ])
    expect(result.map(entry => entry.variant)).toEqual(['Alpha Promo', 'Zeta Promo'])
  })
})

describe('getOwnedVariants — zero quantities', () => {
  it('omits a variant whose total quantity is zero', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', quantity: 0 }),
      row({ id: 2, variant: 'Reverse Holo', quantity: 1 }),
    ])
    expect(result).toEqual([{ variant: 'Reverse Holo', quantity: 1 }])
  })

  it('omits a variant whose quantity is null', () => {
    expect(getOwnedVariants([row({ variant: 'Normal', quantity: null })])).toEqual([])
  })

  it('keeps a variant whose rows sum above zero even if one row is zero', () => {
    const result = getOwnedVariants([
      row({ id: 1, variant: 'Normal', condition: 'NM', quantity: 0 }),
      row({ id: 2, variant: 'Normal', condition: 'LP', quantity: 2 }),
    ])
    expect(result).toEqual([{ variant: 'Normal', quantity: 2 }])
  })
})

describe('sortRowsByVariant', () => {
  it('orders rows canonically regardless of incoming order', () => {
    const rows = [
      row({ id: 1, variant: 'Reverse Holo' }),
      row({ id: 2, variant: 'Normal' }),
      row({ id: 3, variant: 'First Edition' }),
      row({ id: 4, variant: 'Holo' }),
    ]
    expect(sortRowsByVariant(rows).map(r => r.variant)).toEqual([
      'Normal', 'Holo', 'Reverse Holo', 'First Edition',
    ])
  })

  it('keeps rows of the same variant in their original relative order', () => {
    const rows = [
      row({ id: 1, variant: 'Normal', condition: 'LP' }),
      row({ id: 2, variant: 'Normal', condition: 'NM' }),
    ]
    expect(sortRowsByVariant(rows).map(r => r.condition)).toEqual(['LP', 'NM'])
  })

  it('places non-canonical variants after the four canonical prints', () => {
    const rows = [
      row({ id: 1, variant: 'Full Art' }),
      row({ id: 2, variant: 'Normal' }),
    ]
    expect(sortRowsByVariant(rows).map(r => r.variant)).toEqual(['Normal', 'Full Art'])
  })

  it('does not mutate the array it is given', () => {
    const rows = [row({ id: 1, variant: 'Holo' }), row({ id: 2, variant: 'Normal' })]
    sortRowsByVariant(rows)
    expect(rows.map(r => r.variant)).toEqual(['Holo', 'Normal'])
  })
})

describe('getPrimaryVariant', () => {
  it('prefers First Edition over every other owned variant', () => {
    const variant = getPrimaryVariant([
      row({ id: 1, variant: 'Normal' }),
      row({ id: 2, variant: 'Holo' }),
      row({ id: 3, variant: 'Reverse Holo' }),
      row({ id: 4, variant: 'First Edition' }),
    ])
    expect(variant).toBe('First Edition')
  })

  it('prefers Holo over Reverse Holo and Normal when no First Edition is owned', () => {
    const variant = getPrimaryVariant([
      row({ id: 1, variant: 'Normal' }),
      row({ id: 2, variant: 'Reverse Holo' }),
      row({ id: 3, variant: 'Holo' }),
    ])
    expect(variant).toBe('Holo')
  })

  it('prefers Reverse Holo over Normal when that is the only premium print owned', () => {
    const variant = getPrimaryVariant([
      row({ id: 1, variant: 'Normal' }),
      row({ id: 2, variant: 'Reverse Holo' }),
    ])
    expect(variant).toBe('Reverse Holo')
  })

  it('falls back to Normal when it is the only owned variant', () => {
    expect(getPrimaryVariant([row({ variant: 'Normal' })])).toBe('Normal')
  })

  it('is independent of row order', () => {
    const forward = getPrimaryVariant([
      row({ id: 1, variant: 'Normal' }),
      row({ id: 2, variant: 'First Edition' }),
    ])
    const reversed = getPrimaryVariant([
      row({ id: 2, variant: 'First Edition' }),
      row({ id: 1, variant: 'Normal' }),
    ])
    expect(forward).toBe('First Edition')
    expect(reversed).toBe('First Edition')
  })

  it('falls back to the (alphabetically first) unknown variant when no canonical print is owned', () => {
    expect(getPrimaryVariant([row({ variant: 'Promo' })])).toBe('Promo')
  })

  it('returns null for no rows', () => {
    expect(getPrimaryVariant([])).toBeNull()
  })
})

describe('groupCollectionByCard', () => {
  it('groups rows of the same card and sums total quantity', () => {
    const groups = groupCollectionByCard([
      row({ id: 1, variant: 'Normal', quantity: 1 }),
      row({ id: 2, variant: 'Reverse Holo', quantity: 2 }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].cardId).toBe('sv01-003_en')
    expect(groups[0].rows).toHaveLength(2)
    expect(groups[0].totalQuantity).toBe(3)
  })

  it('keeps the same card in different languages apart', () => {
    const groups = groupCollectionByCard([
      row({ id: 1, card_id: 'sv01-003_en', card: { id: 'sv01-003_en' } }),
      row({ id: 2, card_id: 'sv01-003_de', card: { id: 'sv01-003_de' } }),
    ])
    expect(groups.map(group => group.cardId)).toEqual(['sv01-003_en', 'sv01-003_de'])
  })

  it('preserves the incoming order of first appearance', () => {
    const groups = groupCollectionByCard([
      row({ id: 1, card_id: 'b_en', card: { id: 'b_en' } }),
      row({ id: 2, card_id: 'a_en', card: { id: 'a_en' } }),
      row({ id: 3, card_id: 'b_en', card: { id: 'b_en' } }),
    ])
    expect(groups.map(group => group.cardId)).toEqual(['b_en', 'a_en'])
  })
})
