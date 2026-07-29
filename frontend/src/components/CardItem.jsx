import { useState, useEffect, useId, memo } from 'react'
import CardModal from './CardDetailModal'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Plus, Heart, BookOpen, X, PenLine, Pencil, Trash2, ExternalLink } from 'lucide-react'
import { addToCollection, addToWishlist, createCustomCard, updateCustomCard, updateCardCustomImage, deleteCustomCard, getSets, getPriceHistory } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { useTilt } from '../hooks/useTilt'
import { cardImageUrl, resolveCardImageUrl } from '../utils/imageUrl'
import { CARD_VARIANTS, getAvailableVariants, getDefaultVariant, getDefaultVariantOrNull } from '../utils/cardVariants'
import FallbackBadges from './FallbackBadges'
import MoneyInput from './MoneyInput'
import { getEffectiveCardPrice } from '../utils/prices'
import { tcgdexLanguageBadgeClass, tcgdexLanguageLabel, getTcgdexLanguage } from '../utils/tcgdexLanguages'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { parseMoneyInputValue } from '../utils/moneyInput'
import { cardmarketLinks } from '../utils/cardmarket'
import CardStateIndicators from './CardStateIndicators'
import { getCardVariantEffectClass } from '../utils/cardVariantEffect'

function askWishlistQuantity(t, defaultQuantity = 1) {
  const initialQuantity = Math.max(1, Math.min(99, parseInt(defaultQuantity, 10) || 1))
  const input = window.prompt(t('wishlist.quantityPrompt'), String(initialQuantity))
  if (input === null) return null
  const quantity = parseInt(input, 10)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    toast.error(t('wishlist.quantityInvalid'))
    return null
  }
  return quantity
}

const RARITY_COLORS = {
  'Common': 'text-text-secondary',
  'Uncommon': 'text-green',
  'Rare': 'text-blue',
  'Rare Holo': 'text-purple-400',
  'Rare Ultra': 'text-yellow',
  'Rare Secret': 'text-orange-400',
  'Illustration Rare': 'text-pink-400',
  'Special Illustration Rare': 'text-pink-500',
  'Hyper Rare': 'text-yellow',
}

const PRICE_FIELD_MAP = {
  avg: 'price_market',
  market: 'price_market',
  low: 'price_low',
  trend: 'price_trend',
  avg1: 'price_avg1',
  avg7: 'price_avg7',
  avg30: 'price_avg30',
}

function getPriceValue(card, priceKey) {
  const field = PRICE_FIELD_MAP[priceKey] || priceKey
  return card[field]
    ?? card.cardmarket?.prices?.[priceKey]
    ?? card.pricing?.cardmarket?.[priceKey]
    ?? null
}

const POKEMON_TYPES = ['Fire', 'Water', 'Grass', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless', 'Fairy', 'Stellar']

export function CustomCardModal({ onClose, onCreated, sets: setsProp = [], autoAddCollection = false, editCard = null }) {
  const { t, settings, exchangeRate, exchangeRateReady } = useSettings()
  const [name, setName] = useState(editCard?.name || '')
  const [setChoice, setSetChoice] = useState('')
  const [customSetId, setCustomSetId] = useState('')
  const [number, setNumber] = useState(editCard?.number || '')
  const [rarity, setRarity] = useState(editCard?.rarity || '')
  const [selectedTypes, setSelectedTypes] = useState(editCard?.types || [])
  const [hp, setHp] = useState(editCard?.hp || '')
  const [artist, setArtist] = useState(editCard?.artist || '')
  const [imageUrl, setImageUrl] = useState(editCard?.images_small || editCard?.image_url || '')

  const [createdCard, setCreatedCard] = useState(null)
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variant, setVariant] = useState('Normal')
  const [purchasePrice, setPurchasePrice] = useState('')
  const queryClient = useQueryClient()

  const { data: fetchedSets = [] } = useQuery({
    queryKey: ['sets', settings.language || 'en'],
    queryFn: () => getSets().then(r => r.data),
    staleTime: 60000,
    enabled: setsProp.length === 0,
  })
  const sets = setsProp.length > 0 ? setsProp : fetchedSets

  // Resolve editCard.set_id (TCGdex ID like 'pfl') to composite dropdown key ('pfl_de')
  useEffect(() => {
    if (editCard?.set_id && sets.length > 0 && !setChoice) {
      const match = sets.find(s => s.tcg_set_id === editCard.set_id && s.lang === editCard.lang)
        || sets.find(s => s.tcg_set_id === editCard.set_id)
        || sets.find(s => s.id === editCard.set_id)
      if (match) setSetChoice(match.id)
    }
  }, [sets, editCard])

  const isEditMode = !!editCard

  const createMutation = useMutation({
    mutationFn: (data) => createCustomCard(data),
    onSuccess: (res) => {
      toast.success(t('cardSearch.customCardCreated'))
      if (autoAddCollection) {
        setCreatedCard(res.data)
      } else {
        onCreated && onCreated(res.data)
        onClose()
      }
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || t('common.error')
      toast.error(detail)
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data) => updateCustomCard(editCard.id, data),
    onSuccess: (res) => {
      toast.success(t('settings.cardUpdated'))
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      onCreated && onCreated(res)
      onClose()
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || t('common.error')
      toast.error(detail)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteCustomCard(editCard.id),
    onSuccess: (res) => {
      toast.success(res?.data?.message || t('common.success'))
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['custom-cards'] })
      onClose()
    },
    onError: (err) => {
      const detail = err?.response?.data?.detail || t('common.error')
      toast.error(detail)
    },
  })

  const addMutation = useMutation({
    mutationFn: (data) => addToCollection(data),
    onSuccess: () => {
      toast.success(`${createdCard.name} ${t('card.addedToCollection')}`)
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      onCreated && onCreated(createdCard)
      onClose()
    },
    onError: () => toast.error(t('card.addFailed')),
  })

  const handleCreate = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    const effectiveSetId = setChoice === '__custom__' ? customSetId.trim() : setChoice || undefined
    const selectedSet = effectiveSetId ? sets.find(s => s.id === effectiveSetId) : null
    // Use the original TCGdex set ID (tcg_set_id) for cards.set_id, not the composite DB key
    const setIdForCard = selectedSet?.tcg_set_id || effectiveSetId || undefined
    const payload = {
      name: name.trim(),
      set_id: setIdForCard,
      number: number.trim() || undefined,
      rarity: rarity || undefined,
      types: selectedTypes.length > 0 ? selectedTypes : undefined,
      hp: hp.trim() || undefined,
      artist: artist.trim() || undefined,
      image_url: imageUrl.trim() || undefined,
      lang: selectedSet?.lang || 'en',
    }
    if (isEditMode) {
      updateMutation.mutate(payload)
    } else {
      createMutation.mutate(payload)
    }
  }

  const handleAddToCollection = () => {
    addMutation.mutate({
      card_id: createdCard.id,
      quantity,
      condition,
      variant,
      purchase_price: parseMoneyInputValue(purchasePrice, exchangeRate),
      lang: createdCard.lang || 'en',
    })
  }

  const toggleType = (tp) => {
    setSelectedTypes(prev => prev.includes(tp) ? prev.filter(t => t !== tp) : [...prev, tp])
  }

  const handleDelete = () => {
    if (!editCard) return
    if (!window.confirm(t('common.confirm_delete'))) return
    deleteMutation.mutate()
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/60 md:flex md:items-center md:justify-center md:bg-black/80 md:backdrop-blur-sm"
      onClick={onClose}>
      <div className={[
        'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto',
        'bg-bg-surface border-t border-border more-sheet-enter',
        'md:static md:rounded-2xl md:border md:max-w-lg md:w-full md:max-h-[85vh] md:animate-none',
      ].join(' ')} onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <PenLine size={18} className="text-brand-red" />
              <h2 className="text-lg font-bold text-text-primary">
                {isEditMode ? t('card.editCard') : t('cardSearch.createCustomCard')}
              </h2>
              <span className="text-xs bg-yellow/20 text-yellow px-2 py-0.5 rounded-full">✏️ {t('cardSearch.customCard')}</span>
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
              <X size={20} />
            </button>
          </div>

          {!createdCard ? (
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="text-xs text-text-secondary mb-1 block font-medium">
                  {t('common.name')} <span className="text-brand-red">*</span>
                </label>
                <input type="text" required placeholder={t('cardSearch.customNamePlaceholder')} value={name}
                  onChange={(e) => setName(e.target.value)} className="input" />
              </div>
              <div>
                <label className="text-xs text-text-secondary mb-1 block">{t('common.set')}</label>
                <select className="select" value={setChoice} onChange={(e) => setSetChoice(e.target.value)}>
                  <option value="">{t('cardSearch.selectOrTypeSet')}</option>
                  {sets.map(s => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}
                  <option value="__custom__">{t('cardSearch.customSetFreetext')}</option>
                </select>
                {setChoice === '__custom__' && (
                  <input type="text" placeholder={t('cardSearch.customSetIdPlaceholder')} value={customSetId}
                    onChange={(e) => setCustomSetId(e.target.value)} className="input mt-2" />
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('cardSearch.cardNumber')}</label>
                  <input type="text" placeholder={t('cardSearch.cardNumberPlaceholder')} value={number}
                    onChange={(e) => setNumber(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('common.rarity')}</label>
                  <input type="text" placeholder={t('cardSearch.rarityPlaceholder')} value={rarity}
                    onChange={(e) => setRarity(e.target.value)} className="input" />
                </div>
              </div>
              <div>
                <label className="text-xs text-text-secondary mb-2 block">{t('common.type')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {POKEMON_TYPES.map(tp => (
                    <button key={tp} type="button" onClick={() => toggleType(tp)}
                      className={clsx(
                        'text-xs px-2 py-1 rounded-full border transition-all',
                        selectedTypes.includes(tp)
                          ? 'border-brand-red bg-brand-red/20 text-text-primary'
                          : 'border-border text-text-muted hover:border-text-muted'
                      )}>
                      {tp}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('common.hp')}</label>
                  <input type="text" placeholder={t('cardSearch.hpPlaceholder')} value={hp}
                    onChange={(e) => setHp(e.target.value)} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-secondary mb-1 block">{t('common.artist')}</label>
                  <input type="text" placeholder={t('cardSearch.artistPlaceholder')} value={artist}
                    onChange={(e) => setArtist(e.target.value)} className="input" />
                </div>
              </div>
              <div>
                <label className="text-xs text-text-secondary mb-1 block">{t('cardSearch.imageUrl')}</label>
                <input type="url" placeholder="https://..." value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)} className="input" />
                {imageUrl && /^https?:\/\//i.test(imageUrl) && (
                  <div className="mt-2 w-20 h-28 rounded overflow-hidden border border-border">
                    <img src={imageUrl} alt="preview" className="w-full h-full object-cover" onError={(e) => e.target.style.display = 'none'} />
                  </div>
                )}
              </div>
              <div className="flex gap-3 pt-2">
                {isEditMode && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleteMutation.isPending}
                    className="btn-ghost text-brand-red border-brand-red/30 hover:bg-brand-red/10 px-3"
                  >
                    <Trash2 size={16} /> {deleteMutation.isPending ? t('common.deleting') : t('common.delete')}
                  </button>
                )}
                <button type="submit" disabled={(isEditMode ? updateMutation.isPending : createMutation.isPending) || !name.trim()} className="btn-primary flex-1">
                  {isEditMode
                    ? (updateMutation.isPending ? t('common.saving') : t('common.save'))
                    : (createMutation.isPending ? t('common.saving') : (autoAddCollection ? t('cardSearch.createAndAdd') : t('cardSearch.createCustomCard')))
                  }
                </button>
                <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-4 p-3 bg-bg-card rounded-xl border border-border">
                {resolveCardImageUrl(createdCard) ? (
                  <img src={resolveCardImageUrl(createdCard)} alt={createdCard.name} className="w-16 h-20 object-cover rounded" />
                ) : (
                  <div className="w-16 h-20 bg-bg-surface rounded flex items-center justify-center text-text-muted text-xl">🃏</div>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-text-primary">{createdCard.name}</p>
                    <span className="text-xs bg-yellow/20 text-yellow px-1.5 py-0.5 rounded">✏️</span>
                  </div>
                  {createdCard.set_id && <p className="text-xs text-text-muted">{createdCard.set_id}</p>}
                  {createdCard.rarity && <p className="text-xs text-text-muted">{createdCard.rarity}</p>}
                  <p className="text-xs text-green mt-1">{t('cardSearch.customCardCreated')}</p>
                </div>
              </div>

              <p className="text-sm text-text-secondary">{t('cardSearch.addToCollectionAfter')}:</p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.quantity')}</label>
                  <input type="number" min="1" value={quantity}
                    onChange={(e) => setQuantity(parseInt(e.target.value) || 1)} className="input" />
                </div>
                <div>
                  <label className="text-xs text-text-muted mb-1 block">{t('card.condition')}</label>
                  <select value={condition} onChange={(e) => setCondition(e.target.value)} className="select">
                    {['Mint', 'NM', 'LP', 'MP', 'HP'].map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">✨ {t('card.variant')}</label>
                <select value={variant} onChange={(e) => setVariant(e.target.value)} className="select">
                  {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('card.purchasePrice')}</label>
                <MoneyInput
                  placeholder={t('card.purchasePricePlaceholder')}
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                />
              </div>
              <div className="flex gap-3">
                <button onClick={handleAddToCollection} disabled={addMutation.isPending || !exchangeRateReady} className="btn-primary flex-1">
                  <Plus size={16} /> {addMutation.isPending ? t('card.adding') : t('card.addToCollection')}
                </button>
                <button onClick={onClose} className="btn-ghost">{t('common.close')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export const CardItem = memo(function CardItem({ card, showActions = true, onAddToBinder = null, compact = false, lang = null }) {
  const [showModal, setShowModal] = useState(false)
  const [showEditModal, setShowEditModal] = useState(false)
  const { t, pricePrimary, pricePrimaryField, formatPrice } = useSettings()
  const queryClient = useQueryClient()

  const addMutation = useMutation({
    mutationFn: (data) => addToCollection(data),
    onSuccess: () => {
      toast.success(`${card.name} ${t('card.addedToCollection')}`)
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: () => toast.error(t('card.addFailed')),
  })

  const wishlistMutation = useMutation({
    mutationFn: (data) => addToWishlist(data),
    onSuccess: () => {
      toast.success(`${card.name} ${t('card.addedToWishlist')}`)
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: () => toast.error(t('card.wishlistFailed')),
  })

  const cardImage = card.images?.small || resolveCardImageUrl(card) || (card.image ? `${card.image}/low.webp` : null)
  const cardName = card.name
  const cardRarity = card.rarity
  const setName = card.set?.name || card.set_ref?.name || ''
  const selectedPrice = getEffectiveCardPrice(card, null, pricePrimaryField)
  const price = selectedPrice > 0
    ? selectedPrice
    : (getPriceValue(card, pricePrimary)
      ?? card.cardmarket?.prices?.trendPrice
      ?? card.price_market
      ?? card.price_trend)

  const rarityColor = RARITY_COLORS[cardRarity] || 'text-text-secondary'
  const variantEffectClass = getCardVariantEffectClass(card)
  const { ref: tiltRef, onMouseMove: tiltMove, onMouseLeave: tiltLeave } = useTilt(10)

  if (compact) {
    return (
      <div ref={tiltRef} className="card cursor-pointer group p-2 hover:border-brand-red/20 transition-all" onClick={() => setShowModal(true)} onMouseMove={tiltMove} onMouseLeave={tiltLeave}>
        <div className={clsx('relative aspect-[2.5/3.5] w-full rounded-xl overflow-hidden ring-1 ring-white/5 group-hover:ring-2 group-hover:ring-brand-red/30 transition-all duration-200', variantEffectClass)}>
          <CardStateIndicators card={card} compact className="absolute left-1.5 right-1.5 top-1.5 z-10" />
          {cardImage ? (
            <img src={cardImage} alt={cardName} className="w-full h-full object-cover shadow-lg group-hover:scale-[1.02] transition-transform duration-300" loading="lazy" />
          ) : (
            <div className="w-full h-full bg-bg-surface rounded flex items-center justify-center text-text-muted text-xs">
              {t('common.noImage')}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div ref={tiltRef} className="card cursor-pointer group hover:border-brand-red/20 transition-all" onClick={() => setShowModal(true)} onMouseMove={tiltMove} onMouseLeave={tiltLeave}>
        <div className={clsx('relative aspect-[2.5/3.5] w-full mb-3 rounded-xl overflow-hidden ring-1 ring-white/5 group-hover:ring-2 group-hover:ring-brand-red/30 transition-all duration-200', variantEffectClass)}>
          <CardStateIndicators card={card} className="absolute left-2 right-2 top-2 z-10" />
          {cardImage ? (
            <img src={cardImage} alt={cardName} className="w-full h-full object-cover shadow-lg group-hover:scale-[1.02] transition-transform duration-300" loading="lazy" />
          ) : (
            <div className="w-full h-full bg-bg-surface rounded flex items-center justify-center text-text-muted text-sm">
              {t('common.noImage')}
            </div>
          )}
        </div>

        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-1">
            <h3 className="text-sm font-medium text-text-primary truncate">{cardName}</h3>
            {card.is_custom && (
              <span className="flex-shrink-0 text-xs bg-yellow/20 text-yellow px-1 py-0.5 rounded" title={t('migration.custom')}>✏️</span>
            )}
            {lang && (
              <span className={clsx(
                'flex-shrink-0 text-[10px] font-black px-1 py-0.5 rounded leading-none',
                tcgdexLanguageBadgeClass(lang)
              )} title={getTcgdexLanguage(lang).name}>
                {tcgdexLanguageLabel(lang)}
              </span>
            )}
            <FallbackBadges card={card} compact />
          </div>
          {setName && <p className="text-xs text-text-muted truncate">{setName}</p>}

          {/* Card ID: "OBF 125" format */}
          {(() => {
            const setCode = card.set?.id?.toUpperCase() || ''
            const localNum = card.localId || card.number || ''
            const cardIdLabel = `${setCode} ${localNum}`.trim()
            return cardIdLabel ? (
              <p className="text-[10px] font-mono text-brand-red/70 font-semibold">{cardIdLabel}</p>
            ) : null
          })()}

          <div className="flex items-center justify-between">
            {cardRarity && (
              <span className={clsx('text-xs truncate', rarityColor)}>{cardRarity}</span>
            )}
            {price && (
              <span className="text-xs font-bold text-green">{formatPrice(price)}</span>
            )}
          </div>
        </div>

        {showActions && (
          <div className="mt-3 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              className="flex-1 bg-brand-red/20 hover:bg-brand-red/40 text-brand-red text-xs py-1.5 rounded-lg font-medium transition-all flex items-center justify-center gap-1"
              onClick={(e) => {
                e.stopPropagation()
                addMutation.mutate({ card_id: card.id, quantity: 1, condition: 'NM', variant: getDefaultVariantOrNull(card), lang: card.lang || 'en' })
              }}>
              <Plus size={12} /> {t('common.add')}
            </button>
            <button
              className="bg-bg-surface hover:bg-bg-elevated text-text-secondary hover:text-pink-400 text-xs px-2 py-1.5 rounded-lg transition-all"
              onClick={(e) => {
                e.stopPropagation()
                const wishlistQuantity = askWishlistQuantity(t, 1)
                if (wishlistQuantity) wishlistMutation.mutate({ card_id: card.id, quantity: wishlistQuantity })
              }}>
              <Heart size={12} />
            </button>
            {onAddToBinder && (
              <button
                className="bg-bg-surface hover:bg-bg-elevated text-text-secondary hover:text-blue text-xs px-2 py-1.5 rounded-lg transition-all"
                onClick={(e) => { e.stopPropagation(); onAddToBinder(card.id) }}>
                <BookOpen size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {showModal && (
        <CardModal
          card={card}
          onClose={() => setShowModal(false)}
          onEdit={card.is_custom ? () => { setShowModal(false); setShowEditModal(true) } : undefined}
        />
      )}
      {showEditModal && (
        <CustomCardModal
          editCard={card}
          onClose={() => setShowEditModal(false)}
          onCreated={() => {
            invalidateCardState(queryClient)
            invalidateTcgdexFilterLanguages(queryClient)
          }}
          sets={[]}
        />
      )}
    </>
  )
})

export { default as CardModal } from './CardDetailModal'

export default CardItem
