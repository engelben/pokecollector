export const CARD_VARIANTS = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']

export const getAvailableVariants = (card) => [
  card?.variants_normal && 'Normal',
  card?.variants_reverse && 'Reverse Holo',
  card?.variants_holo && 'Holo',
  card?.variants_first_edition && 'First Edition',
].filter(Boolean)

export const getDefaultVariant = (card) => {
  // Normal availability means the safest default is the plain/non-holo card.
  if (card?.variants_normal) return 'Normal'
  const available = getAvailableVariants(card)
  // If there is no Normal print, default to a real advertised variant instead
  // of creating an impossible Normal collection row.
  if (available.length > 0) return available[0]
  return 'Normal'
}

export const getDefaultVariantOrNull = (card) => getDefaultVariant(card)

export const VARIANT_ORDER = ['Normal', 'Holo', 'Reverse Holo', 'First Edition']

export const VARIANT_PILL_META = {
  'Normal':        { code: 'NOR', className: 'bg-bg-elevated text-text-secondary border-border' },
  'Holo':          { code: 'HOL', className: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  'Reverse Holo':  { code: 'REV', className: 'bg-blue/15 text-blue border-blue/30' },
  'First Edition': { code: '1ST', className: 'bg-yellow/15 text-yellow border-yellow/30' },
}

// Rows of the same variant differing only by condition (a NM and an LP Normal) are one
// pill: the pill answers "do I own a Normal", not "how many rows exist".
export const getOwnedVariants = (rows = []) => {
  const totals = new Map()
  for (const row of rows) {
    const variant = row?.variant || 'Normal'
    totals.set(variant, (totals.get(variant) || 0) + (row?.quantity || 0))
  }

  const ordered = VARIANT_ORDER
    .filter(variant => totals.has(variant))
    .map(variant => ({ variant, quantity: totals.get(variant) }))

  // Anything outside the four canonical prints (a hand-edited CSV import, say) still
  // gets a pill rather than vanishing.
  const unknown = [...totals.keys()]
    .filter(variant => !VARIANT_ORDER.includes(variant))
    .sort()
    .map(variant => ({ variant, quantity: totals.get(variant) }))

  return [...ordered, ...unknown]
}

// Card ids carry a language suffix (sv01-003_en), so grouping by card id keeps the
// English and German copies of a card in separate tiles.
export const groupCollectionByCard = (items = []) => {
  const groups = new Map()
  for (const item of items) {
    const cardId = item?.card_id ?? item?.card?.id
    if (!cardId) continue
    if (!groups.has(cardId)) {
      groups.set(cardId, { cardId, card: item.card, rows: [], totalQuantity: 0 })
    }
    const group = groups.get(cardId)
    group.rows.push(item)
    group.totalQuantity += item.quantity || 0
  }
  return [...groups.values()]
}
