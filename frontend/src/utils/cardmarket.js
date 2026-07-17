function normalizeVariant(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'reverse holo' || normalized === 'reverse') return 'reverse'
  if (normalized === 'first edition' || normalized === 'first-edition' || normalized === '1st edition') return 'first edition'
  if (normalized === 'holo') return 'holo'
  if (normalized === 'normal') return 'normal'
  return normalized || null
}

function variantLabel(variant, foil) {
  const normalized = normalizeVariant(variant)
  const base = {
    normal: 'Normal',
    holo: 'Holo',
    reverse: 'Reverse Holo',
    'first edition': 'First Edition',
  }[normalized] || (variant ? String(variant) : '')
  return [base, foil].filter(Boolean).join(' · ')
}

function productUrl(productId, selectedVariant) {
  const params = new URLSearchParams({ idProduct: String(productId) })
  if (normalizeVariant(selectedVariant) === 'reverse') {
    params.set('isReverseHolo', 'Y')
  }
  return `https://www.cardmarket.com/en/Pokemon/Products?${params.toString()}`
}

function normalizeProductRows(card) {
  const rows = Array.isArray(card?.cardmarket_products) ? card.cardmarket_products : []
  return rows.flatMap((row) => {
    const productId = Number(row?.product_id)
    if (!Number.isInteger(productId) || productId <= 0) return []
    return [{
      productId,
      variant: normalizeVariant(row?.variant),
      foil: row?.foil ? String(row.foil) : null,
      label: variantLabel(row?.variant, row?.foil),
    }]
  })
}

function selectProductRows(rows, requestedVariant) {
  if (!requestedVariant) return rows

  const exact = rows.filter((row) => row.variant === requestedVariant)
  if (exact.length > 0) return exact

  // TCGdex does not always repeat the Cardmarket catalogue ID for every
  // finish. Cardmarket frequently uses one product page for normal/holo and
  // reverse listings, with reverse selected through a query parameter. Keep
  // the exact product link in that case instead of degrading to a broad
  // search. Prefer the ordinary, non-promotional product over special foils.
  const ordinary = rows.filter((row) => !row.foil && row.variant !== 'first edition')
  if (ordinary.length > 0) return ordinary

  const withoutSpecialEdition = rows.filter((row) => row.variant !== 'first edition')
  return withoutSpecialEdition.length > 0 ? withoutSpecialEdition : rows
}

export function cardmarketProductLinks(card, selectedVariant = null) {
  const requestedVariant = normalizeVariant(selectedVariant)
  const rows = normalizeProductRows(card)
  const selectedRows = selectProductRows(rows, requestedVariant)

  const grouped = new Map()
  selectedRows.forEach((row) => {
    const linkVariant = requestedVariant || row.variant
    const reverse = linkVariant === 'reverse'
    const key = `${row.productId}:${reverse ? 'reverse' : 'standard'}`
    const current = grouped.get(key) || {
      productId: row.productId,
      variant: linkVariant,
      labels: [],
      url: productUrl(row.productId, linkVariant),
    }
    const label = requestedVariant
      ? variantLabel(requestedVariant, row.variant === requestedVariant ? row.foil : null)
      : row.label
    if (label && !current.labels.includes(label)) current.labels.push(label)
    grouped.set(key, current)
  })

  return [...grouped.values()].map(({ productId, labels, url, variant }) => ({
    productId,
    variant,
    label: labels.join(' / ') || null,
    url,
  }))
}

export function cardmarketSearchUrl(card, selectedVariant = null) {
  const setCode = card?.set_ref?.abbreviation || card?.set_ref?.tcg_set_id || card?.set_id || ''
  const query = [card?.name, setCode, card?.number].filter(Boolean).join(' ')
  const params = new URLSearchParams({
    searchMode: 'v2',
    idCategory: '51',
    idExpansion: '0',
    searchString: query,
    idRarity: '0',
  })
  if (normalizeVariant(selectedVariant) === 'reverse') {
    params.set('isReverseHolo', 'Y')
  }
  return `https://www.cardmarket.com/en/Pokemon/Products/Singles?${params.toString()}`
}

export function cardmarketLinks(card, selectedVariant = null) {
  const exact = cardmarketProductLinks(card, selectedVariant)
  if (exact.length) return exact
  return [{
    productId: null,
    variant: normalizeVariant(selectedVariant),
    label: null,
    url: cardmarketSearchUrl(card, selectedVariant),
    fallback: true,
  }]
}
