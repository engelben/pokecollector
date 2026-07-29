import { useState, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Plus, Heart, X, PenLine, Pencil, ExternalLink } from 'lucide-react'
import { addToCollection, addToWishlist, updateCardCustomImage, getSets, getPriceHistory } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { cardImageUrl, resolveCardImageUrl } from '../utils/imageUrl'
import { CARD_VARIANTS, getAvailableVariants, getDefaultVariant } from '../utils/cardVariants'
import FallbackBadges from './FallbackBadges'
import MoneyInput from './MoneyInput'
import { getEffectiveCardPrice } from '../utils/prices'
import { tcgdexLanguageBadgeClass, tcgdexLanguageLabel, getTcgdexLanguage } from '../utils/tcgdexLanguages'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { parseMoneyInputValue } from '../utils/moneyInput'
import { cardmarketLinks } from '../utils/cardmarket'

const PRICE_FIELD_MAP = { avg: 'price_market', market: 'price_market', low: 'price_low', trend: 'price_trend', avg1: 'price_avg1', avg7: 'price_avg7', avg30: 'price_avg30' }
function getPriceValue(card, priceKey) {
  const field = PRICE_FIELD_MAP[priceKey] || priceKey
  return card[field] ?? card.cardmarket?.prices?.[priceKey] ?? card.pricing?.cardmarket?.[priceKey] ?? null
}

export function CardModal({ card, onClose, onEdit, defaultLang = 'en', ownedItems = null, actions = null, showWishlistAction = true }) {
  if (!card || !card.id) return null

  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState(() => getDefaultVariant(card))
  const [purchasePrice, setPurchasePrice] = useState('')
  const [language, setLanguage] = useState(card.lang || defaultLang)
  const [resolvedCardId, setResolvedCardId] = useState(card.id)
  const [customImageUrl, setCustomImageUrl] = useState(card.custom_image_url || '')
  const [savedCustomImageUrl, setSavedCustomImageUrl] = useState(card.custom_image_url || '')
  const [customImageVersion, setCustomImageVersion] = useState(0)
  const customImageInputId = useId()
  const dialogRef = useRef(null)
  const openerRef = useRef(typeof document !== 'undefined' ? document.activeElement : null)
  const { t, settings, formatPrice, formatUsdPrice, pricePrimary, pricePrimaryField, exchangeRate, exchangeRateReady } = useSettings()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { data: modalSets = [] } = useQuery({
    queryKey: ['sets', settings.language || 'en'],
    queryFn: () => getSets().then(r => r.data),
    enabled: Boolean(card.set_ref?.id || card.set?.id || card.set_id),
    staleTime: 5 * 60 * 1000,
  })

  // Price history chart
  const cardIdForHistory = card?.card_id || (typeof card?.id === 'string' ? card.id : null)
  const { data: priceHistory = [] } = useQuery({
    queryKey: ['price-history', cardIdForHistory],
    queryFn: () => getPriceHistory(cardIdForHistory).then(r => r.data),
    enabled: typeof cardIdForHistory === 'string' && cardIdForHistory.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  useEffect(() => {
    const nextUrl = card.custom_image_url || ''
    setCustomImageUrl(nextUrl)
    setSavedCustomImageUrl(nextUrl)
  }, [card.id, card.custom_image_url])

  const safePriceHistory = Array.isArray(priceHistory) ? priceHistory : []
  const hasApiImage = Boolean(card?.images?.large || card?.images_large || card?.images?.small || card?.images_small || card?.image)
  const customImageCardId = card?.card_id || card?.id
  const canEditCustomImage = !card.is_custom && !hasApiImage && typeof customImageCardId === 'string'
  const customImageProxyUrl = canEditCustomImage && savedCustomImageUrl
    ? `${cardImageUrl(customImageCardId, 'large')}?v=${customImageVersion}`
    : null
  const cardImage = card?.images?.large
    || card?.images_large
    || (card?.image ? `${card.image}/high.webp` : null)
    || card?.images?.small
    || card?.images_small
    || customImageProxyUrl
    || resolveCardImageUrl(card, 'large')
    || resolveCardImageUrl(card)
  const setName = card.set?.name || card.set_ref?.name
  const setCandidates = [
    card.set_ref?.id,
    card.set_ref?.tcg_set_id,
    card.set?.id,
    card.set?.tcg_set_id,
    card.set_id,
  ].filter(Boolean)
  const setNavigationLanguage = card.set_ref?.lang || card.set?.lang || card.lang || defaultLang
  const setDetailId = card.set_ref?.id
    || modalSets.find(set => setCandidates.includes(set.id) && (!setNavigationLanguage || set.lang === setNavigationLanguage))?.id
    || modalSets.find(set => setCandidates.includes(set.tcg_set_id) && (!setNavigationLanguage || set.lang === setNavigationLanguage))?.id
    || modalSets.find(set => setCandidates.includes(set.id) || setCandidates.includes(set.tcg_set_id))?.id
    || null
  const dexIds = [...new Set(
    (Array.isArray(card.dex_ids) ? card.dex_ids : card.dex_id != null ? [card.dex_id] : [])
      .map(Number)
      .filter(dexId => Number.isInteger(dexId) && dexId > 0)
  )]
  const navigateFromModal = (target) => {
    onClose()
    navigate(target)
  }
  const modalOwnedItems = ownedItems || card.owned_items || []
  const ownedQuantity = card.owned_quantity ?? modalOwnedItems.reduce((sum, item) => sum + (item.quantity || 0), 0)
  const availableVariants = getAvailableVariants(card)
  const selectableVariants = availableVariants.length > 0 ? availableVariants : CARD_VARIANTS
  const availableVariantKey = availableVariants.join('|')
  const marketLinks = cardmarketLinks(card, variant)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      openerRef.current?.focus?.()
    }
  }, [onClose])

  useEffect(() => {
    if (availableVariants.length > 0 && !availableVariants.includes(variant)) {
      setVariant(getDefaultVariant(card))
    }
  }, [card.id, availableVariantKey, variant])

  const addMutation = useMutation({
    mutationFn: (data) => addToCollection(data),
    onSuccess: () => {
      toast.success(`${t('common.add')} ${quantity}x ${card.name}!`)
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      onClose()
    },
    onError: () => toast.error(t('card.addFailed')),
  })

  const wishlistMutation = useMutation({
    mutationFn: (data) => addToWishlist(data),
    onSuccess: () => {
      toast.success(`${card.name} ${t('card.addedToWishlist')}`)
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      onClose()
    },
    onError: () => toast.error(t('card.wishlistFailed')),
  })

  const customImageMutation = useMutation({
    mutationFn: (url) => updateCardCustomImage(card.card_id || card.id, { custom_image_url: url || null }),
    onSuccess: (updatedCard) => {
      const nextUrl = updatedCard?.custom_image_url || ''
      setCustomImageUrl(nextUrl)
      setSavedCustomImageUrl(nextUrl)
      setCustomImageVersion((version) => version + 1)
      toast.success(t('card.customImageSaved'))
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || t('common.error')
      toast.error(detail)
    },
  })

  const ALL_PRICE_KEYS = ['trend', 'avg', 'avg1', 'avg7', 'avg30', 'low']
  const ALL_HOLO_PRICE_KEYS = ['trend-holo', 'avg-holo', 'avg1-holo', 'avg7-holo', 'avg30-holo', 'low-holo']

  const HOLO_PRICE_FIELD_MAP = {
    'trend-holo': 'price_trend_holo',
    'avg-holo': 'price_market_holo',
    'avg1-holo': 'price_avg1_holo',
    'avg7-holo': 'price_avg7_holo',
    'avg30-holo': 'price_avg30_holo',
    'low-holo': 'price_low_holo',
  }

  const displayedPrices = ALL_PRICE_KEYS
    .map(key => {
      const val = getPriceValue(card, key)
      return val != null ? { key, val } : null
    })
    .filter(Boolean)

  const displayedHoloPrices = ALL_HOLO_PRICE_KEYS
    .map(key => {
      const field = HOLO_PRICE_FIELD_MAP[key]
      const val = card[field]
      const displayKey = key.replace('-holo', '')
      return val != null ? { key, displayKey, val } : null
    })
    .filter(Boolean)

  const isReverseHolo = variant === 'Reverse Holo'
  const selectedPriceBreakdown = isReverseHolo && displayedHoloPrices.length > 0
    ? displayedHoloPrices
    : displayedPrices.map(({ key, val }) => ({ key, displayKey: key, val }))

  const tcgPrices = [
    card.price_tcg_normal_market != null ? { key: 'tcg-normal', val: card.price_tcg_normal_market, label: 'Normal' } : null,
    card.price_tcg_reverse_market != null ? { key: 'tcg-reverse', val: card.price_tcg_reverse_market, label: 'Reverse' } : null,
    card.price_tcg_holo_market != null ? { key: 'tcg-holo', val: card.price_tcg_holo_market, label: 'Holo' } : null,
  ].filter(Boolean)

  const effectivePrimaryPrice = getEffectiveCardPrice(card, variant, pricePrimaryField)
  const selectedPrimaryPrice = effectivePrimaryPrice > 0 ? effectivePrimaryPrice : getPriceValue(card, pricePrimary)
  const historyPriceField = ['price_market', 'price_trend', 'price_low'].includes(pricePrimaryField) ? pricePrimaryField : 'price_market'
  const historyDataKey = historyPriceField
  const historyPriceLabel = pricePrimaryField === historyPriceField ? t(`prices.${pricePrimary}`) : t('prices.avg')

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/60 md:flex md:items-center md:justify-center md:bg-black/80 md:backdrop-blur-sm"
      onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={card.name} tabIndex={-1} className={[
        'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto',
        'bg-bg-surface border-t border-border more-sheet-enter',
        'md:static md:rounded-2xl md:border md:max-w-2xl md:w-full md:max-h-[85vh] md:animate-none',
      ].join(' ')} onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>

        <div className="flex flex-col sm:flex-row gap-4 sm:gap-6 p-4 sm:p-6">
          <div className="flex-shrink-0">
            <div className="flex sm:block items-start gap-4">
              <div className={`w-28 sm:w-48 flex-shrink-0 rounded-xl overflow-hidden ${getCardVariantEffectClass(variant)}`}>
                {cardImage ? (
                  <img src={cardImage} alt={card.name} className="w-full shadow-2xl" />
                ) : (
                  <div className="w-full aspect-[2.5/3.5] bg-bg-card rounded-xl flex items-center justify-center text-text-muted text-sm">
                    {t('common.noImage')}
                  </div>
                )}
              </div>

              <div className="sm:hidden flex-1 min-w-0 pt-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-base font-bold text-text-primary break-words">{card.name}</h2>
                    {setName && (
                      <p className="text-xs text-text-secondary mt-0.5">
                        {setDetailId ? (
                          <button
                            type="button"
                            onClick={() => navigateFromModal(`/sets/${setDetailId}`)}
                            className="font-medium hover:text-brand-red hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/50 rounded"
                          >
                            {setName}
                          </button>
                        ) : setName}
                        {card.number ? ` · #${card.number}` : ''}
                      </p>
                    )}
                    <FallbackBadges card={card} className="mt-1" />
                    {card.rarity && (
                      <p className={`text-xs mt-0.5 ${(RARITY_COLORS[card.rarity] || 'text-text-secondary')}`}>
                        {card.rarity}
                      </p>
                    )}
                  </div>
                  <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors flex-shrink-0 p-1">
                    <X size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0 space-y-4">
            <div className="hidden sm:flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-xl font-bold text-text-primary break-words">{card.name}</h2>
                {setName && (
                  <p className="text-sm text-text-secondary">
                    {setDetailId ? (
                      <button
                        type="button"
                        onClick={() => navigateFromModal(`/sets/${setDetailId}`)}
                        className="font-medium hover:text-brand-red hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/50 rounded"
                      >
                        {setName}
                      </button>
                    ) : setName}
                    {card.number ? ` · #${card.number}` : ''}
                  </p>
                )}
                <FallbackBadges card={card} className="mt-1" />
              </div>
              <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors flex-shrink-0">
                <X size={20} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              {card.rarity && (
                <div className="hidden sm:block">
                  <span className="text-text-muted">{t('card.rarity')}</span>
                  <p className="text-text-primary font-medium">{card.rarity}</p>
                </div>
              )}
              {(card.supertype || card.types) && (
                <div>
                  <span className="text-text-muted text-xs">{t('card.type')}</span>
                  <p className="text-text-primary font-medium text-sm">
                    {card.supertype}{card.types ? ` (${card.types.join(', ')})` : ''}
                  </p>
                </div>
              )}
              {card.hp && (
                <div>
                  <span className="text-text-muted text-xs">{t('card.hp')}</span>
                  <p className="text-text-primary font-medium text-sm">{card.hp}</p>
                </div>
              )}
              {card.artist && (
                <div>
                  <span className="text-text-muted text-xs">{t('card.artist')}</span>
                  <button
                    type="button"
                    onClick={() => navigateFromModal(`/search?${new URLSearchParams({ artist: card.artist }).toString()}`)}
                    className="block max-w-full truncate text-left text-text-primary font-medium text-sm hover:text-brand-red hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/50 rounded"
                  >
                    {card.artist}
                  </button>
                </div>
              )}
              {dexIds.length > 0 && (
                <div>
                  <span className="text-text-muted text-xs">{t('nav.pokedex')}</span>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {dexIds.map(dexId => (
                      <button
                        key={dexId}
                        type="button"
                        onClick={() => navigateFromModal(`/pokedex/${dexId}`)}
                        className="rounded-full border border-border bg-bg-card px-2 py-1 text-xs font-semibold text-text-primary hover:border-brand-red/50 hover:text-brand-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-red/50"
                      >
                        #{String(dexId).padStart(3, '0')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {selectedPriceBreakdown.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                    {t('prices.cardmarketTitle')} · {variant}
                  </p>
                </div>
                {selectedPrimaryPrice != null && (
                  <p className="text-2xl font-bold text-green">{formatPrice(selectedPrimaryPrice)}</p>
                )}
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 text-xs border-t border-border pt-2">
                  {selectedPriceBreakdown.map(({ key, displayKey, val }) => (
                    <div key={key}>
                      <span className="text-text-muted">{t(`prices.${displayKey}`)}</span>
                      <p className={displayKey === 'trend' ? 'text-green font-bold' : 'text-text-primary font-bold'}>
                        {formatPrice(val)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!card.is_custom && marketLinks.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2 border border-border">
                <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                  {t('cardmarket.buy')}
                </p>
                <div className="flex flex-wrap gap-2">
                  {marketLinks.map((link) => (
                    <a
                      key={link.productId || link.url}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-ghost text-xs inline-flex items-center gap-1.5"
                    >
                      <ExternalLink size={14} />
                      {link.fallback
                        ? t('cardmarket.search')
                        : link.label || t('cardmarket.openProduct')}
                    </a>
                  ))}
                </div>
                {marketLinks.some((link) => link.fallback) && (
                  <p className="text-[10px] text-text-muted">{t('cardmarket.searchFallback')}</p>
                )}
              </div>
            )}

            {tcgPrices.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2">
                <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                  TCGPlayer
                </p>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  {tcgPrices.map(({ key, val, label }) => (
                    <div key={key}>
                      <span className="text-text-muted block">{label}</span>
                      <span className="font-bold text-blue-400">{formatUsdPrice(val)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {canEditCustomImage && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2 border border-border">
                <div>
                  <label htmlFor={customImageInputId} className="text-xs text-text-muted font-medium uppercase tracking-wide block">
                    {t('card.customImageUrl')}
                  </label>
                  <p className="text-xs text-text-secondary mt-1">
                    {t('card.customImageUrlDesc')}
                  </p>
                </div>
                <input
                  id={customImageInputId}
                  type="url"
                  placeholder="https://..."
                  value={customImageUrl}
                  onChange={(e) => setCustomImageUrl(e.target.value)}
                  className="input w-full"
                />
                {customImageProxyUrl && (
                  <div className="w-20 h-28 rounded overflow-hidden border border-border">
                    <img src={customImageProxyUrl} alt="" className="w-full h-full object-cover" />
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => customImageMutation.mutate(customImageUrl.trim())}
                    disabled={customImageMutation.isPending || customImageUrl.trim() === savedCustomImageUrl}
                    className="btn-primary text-sm"
                  >
                    {customImageMutation.isPending ? t('common.saving') : t('card.saveCustomImage')}
                  </button>
                  {savedCustomImageUrl && (
                    <button
                      type="button"
                      onClick={() => customImageMutation.mutate('')}
                      disabled={customImageMutation.isPending}
                      className="btn-ghost text-sm"
                    >
                      {t('card.clearCustomImage')}
                    </button>
                  )}
                </div>
              </div>
            )}


            {/* Price History Chart */}
            {safePriceHistory && safePriceHistory.length > 0 && (
              <div className="bg-bg-card rounded-xl p-3 space-y-2">
                <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
                  {t('prices.history')}
                </p>
                <div className="h-[140px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={safePriceHistory} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 10, fill: '#606078' }}
                        tickFormatter={(d) => { try { return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) } catch { return '' } }}
                        axisLine={false}
                        tickLine={false}
                        minTickGap={30}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#606078' }}
                        tickFormatter={(v) => { try { return formatPrice(Number(v)) } catch { return '' } }}
                        axisLine={false}
                        tickLine={false}
                        width={40}
                        domain={['auto', 'auto']}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'rgba(20,20,34,0.95)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '0.75rem',
                          fontSize: '0.75rem',
                        }}
                        labelFormatter={(d) => new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' })}
                        formatter={(val) => { try { return [formatPrice(Number(val)), historyPriceLabel] } catch { return ['', ''] } }}
                      />
                      <Area
                        type="monotone"
                        dataKey={historyDataKey}
                        stroke="#22c55e"
                        fill="url(#priceGrad)"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 3, fill: '#22c55e', stroke: 'none' }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                {(() => {
                  const first = safePriceHistory[0]?.[historyDataKey]
                  const last = safePriceHistory[safePriceHistory.length - 1]?.[historyDataKey]
                  if (first && last && first > 0) {
                    const change = ((last - first) / first) * 100
                    return (
                      <p className={`text-xs font-semibold ${change >= 0 ? 'text-green' : 'text-brand-red'}`}>
                        {change >= 0 ? '↑' : '↓'} {Math.abs(change).toFixed(1)}% {t('prices.sinceTracking')}
                      </p>
                    )
                  }
                  return null
                })()}
              </div>
            )}
            <div className="space-y-3">
              {ownedQuantity > 0 && (
                <div className="rounded-xl border border-green/30 bg-green/10 p-3">
                  <p className="text-sm font-semibold text-green">✓ {t('cardSearch.alreadyOwned')} · {ownedQuantity}x</p>
                  {modalOwnedItems.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {modalOwnedItems.map(item => (
                        <span key={item.id} className="text-[10px] px-2 py-1 rounded-full bg-bg-elevated text-text-secondary border border-border">
                          {[item.variant || 'Normal', item.condition, item.lang?.toUpperCase(), item.purchase_price != null ? formatPrice(item.purchase_price) : null, `${item.quantity}x`].filter(Boolean).join(' · ')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.quantity')}</label>
                  <input type="number" min="1" max="99" value={quantity}
                    onChange={(e) => setQuantity(Math.max(1, Math.min(99, parseInt(e.target.value) || 1)))} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                  <select value={condition} onChange={(e) => setCondition(e.target.value)} className="select">
                    {['Mint', 'NM', 'LP', 'MP', 'HP'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('lang.selectLabel')}</label>
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className="select">
                  {[...new Set([card.lang, defaultLang, 'en', 'de'].filter(Boolean))].map(lang => (
                    <option key={lang} value={lang}>{tcgdexLanguageLabel(lang)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block font-medium">✨ {t('card.variant')}</label>
                <select value={variant} onChange={(e) => setVariant(e.target.value)} className="select">
                  {selectableVariants.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
                {availableVariants.length > 0 && (
                  <p className="text-[10px] text-text-muted mt-1">
                    📋 {t('card.availableVariants')}: {availableVariants.join(', ')}
                  </p>
                )}
              </div>
              {card.rarity && (
                <div>
                  <label className="text-xs text-text-muted mb-1 block font-medium">💎 {t('card.rarity')}</label>
                  <p className="text-sm text-text-primary font-medium px-3 py-1.5 rounded-lg bg-bg-card border border-border">
                    {card.rarity}
                  </p>
                </div>
              )}
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                <MoneyInput
                  placeholder={t('card.purchasePricePlaceholder')}
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                />
              </div>

              <div className="flex gap-2 pb-safe">
                <button className="btn-primary flex-1" onClick={() => addMutation.mutate({
                  card_id: resolvedCardId, quantity, condition,
                  variant,
                  purchase_price: parseMoneyInputValue(purchasePrice, exchangeRate),
                  lang: language,
                })} disabled={addMutation.isPending || !exchangeRateReady}>
                  <Plus size={16} /> {addMutation.isPending ? t('card.adding') : t('card.addToCollection')}
                </button>
                {showWishlistAction && <button className="btn-ghost" onClick={() => wishlistMutation.mutate({ card_id: card.id, quantity: Math.max(1, Math.min(99, quantity)) })}
                  disabled={wishlistMutation.isPending}>
                  <Heart size={16} />
                </button>}
                {card.is_custom && onEdit && (
                  <button
                    className="btn-ghost text-yellow border-yellow/30 hover:bg-yellow/10 flex items-center gap-1.5"
                    onClick={onEdit}
                  >
                    <Pencil size={14} /> {t('common.edit')}
                  </button>
                )}
              </div>
              {actions && <div className="border-t border-border pt-3">{actions}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}


export default CardModal
