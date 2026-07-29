/** A search-friendly card name, matching the common "Name (SET 123)" format. */
export function searchableCardName(card = {}) {
  const name = String(card.name || '').trim()
  const setCode = String(
    card.set_ref?.abbreviation
      || card.set?.abbreviation
      || card.set_ref?.tcg_set_id
      || card.set_id
      || ''
  ).trim().toUpperCase()
  const number = String(card.number || '').trim().replace(/^#\s*/, '')

  return setCode && number ? `${name} (${setCode} ${number})` : name
}
