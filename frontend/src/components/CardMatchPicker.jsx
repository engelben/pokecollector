import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Search, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { searchPhotoImportCards } from '../api/client'
import PhotoImportImage from './PhotoImportImage'
import { useSettings } from '../contexts/SettingsContext'

function cardKey(card) {
  return card?.id || `${card?.name}-${card?.set_id}-${card?.number}-${card?.lang}`
}

function CardChoice({ card, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-xl border p-2 text-left transition-colors ${active ? 'border-brand-red bg-brand-red/10' : 'border-border bg-bg-card hover:border-white/20'}`}
    >
      <div className="flex gap-3">
        <PhotoImportImage
          src={card.image || card.images_small}
          alt={card.name || ''}
          className="h-24 w-16 flex-shrink-0 rounded-lg object-cover"
        />
        <div className="min-w-0 flex-1 py-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate font-bold text-text-primary">{card.name || 'Unknown card'}</p>
            {active && <Check size={16} className="flex-shrink-0 text-brand-red" />}
          </div>
          <p className="mt-1 text-xs font-mono text-brand-red/90">
            {`${(card.set_abbreviation || card.set_id || '').toUpperCase()} ${card.number || ''}`.trim()}
          </p>
          <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{card.set || card.set_name || card.set_id || '—'}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {card.lang && <span className="badge-gray text-[10px] uppercase">{card.lang}</span>}
            {(card.dex_ids || []).slice(0, 3).map(dexId => (
              <span key={dexId} className="badge-blue text-[10px]">#{String(dexId).padStart(3, '0')}</span>
            ))}
          </div>
        </div>
      </div>
    </button>
  )
}

export default function CardMatchPicker({ sessionId, lang = 'all', candidates = [], onClose, onConfirm }) {
  const { t } = useSettings()
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selected, setSelected] = useState(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  const searchQuery = useQuery({
    queryKey: ['photo-import', 'card-search', sessionId, debouncedQuery, lang],
    queryFn: () => searchPhotoImportCards(sessionId, { q: debouncedQuery, lang }),
    enabled: debouncedQuery.length > 0,
    staleTime: 30_000,
  })

  const visibleCards = useMemo(() => {
    const source = debouncedQuery ? (searchQuery.data?.data || []) : candidates
    const seen = new Set()
    return source.filter(card => {
      const key = cardKey(card)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [candidates, debouncedQuery, searchQuery.data])

  return (
    <div className="fixed inset-0 z-[400] bg-black/80 backdrop-blur-sm flex items-end md:items-center justify-center" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[92dvh] overflow-hidden rounded-t-2xl md:rounded-2xl border border-border bg-bg-surface shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border p-4">
          <div>
            <h2 className="font-black text-text-primary">{t('photoImport.changeCard')}</h2>
            <p className="text-xs text-text-secondary">{t('photoImport.searchHelp')}</p>
          </div>
          <button type="button" onClick={onClose} className="btn-ghost p-2"><X size={18} /></button>
        </div>

        <div className="p-4">
          <div className="relative">
            <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('photoImport.searchPlaceholder')}
              className="input w-full pl-10"
            />
          </div>
        </div>

        <div className="max-h-[58dvh] overflow-y-auto px-4 pb-4">
          {!debouncedQuery && candidates.length > 0 && (
            <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-text-muted">{t('photoImport.likelyCandidates')}</p>
          )}
          {searchQuery.isFetching && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-secondary">
              <Loader2 size={18} className="animate-spin" /> {t('common.search')}…
            </div>
          )}
          {!searchQuery.isFetching && visibleCards.length === 0 && (
            <p className="py-10 text-center text-sm text-text-muted">{t('common.noResults')}</p>
          )}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {visibleCards.map(card => (
              <CardChoice
                key={cardKey(card)}
                card={card}
                active={cardKey(selected) === cardKey(card)}
                onClick={() => setSelected(card)}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => selected && onConfirm(selected)}
            className="btn-primary"
          >
            <Check size={16} /> {t('photoImport.useSelectedCard')}
          </button>
        </div>
      </div>
    </div>
  )
}
