export function invalidateTcgdexFilterLanguages(queryClient) {
  queryClient.invalidateQueries({ queryKey: ['tcgdex-filter-languages'] })
  // Collection and wishlist mutations can change species completion and the
  // ordering shown on Pokédex detail pages.
  queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'pokedex' })
}
