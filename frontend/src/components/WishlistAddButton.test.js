import { describe, expect, it } from 'vitest'
import { buildWishlistPayload } from './WishlistAddButton'

describe('buildWishlistPayload', () => {
  it('preserves the modal quantity, variant, condition, and selected wishlist', () => {
    expect(buildWishlistPayload({
      card: { id: 'sv1-42' },
      quantity: 2,
      variant: 'Reverse Holo',
      condition: 'NM',
      wishlistId: '7',
    })).toEqual({
      card_id: 'sv1-42',
      quantity: 2,
      desired_variant: 'Reverse Holo',
      desired_condition: 'NM',
      wishlist_id: 7,
    })
  })

  it('uses safe wishlist defaults and clamps quantity', () => {
    expect(buildWishlistPayload({ card: { id: 'base-1' }, quantity: 120 })).toEqual({
      card_id: 'base-1',
      quantity: 99,
      desired_variant: 'Any',
      desired_condition: 'Any',
    })
  })
})
