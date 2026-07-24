import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive, Check, Copy, Download, Edit2, ExternalLink, Heart, Library,
  Grid2X2, List, Minus, MoveRight, Plus, Save, Search, Trash2, X,
} from 'lucide-react'
import {
  addToCollection, createWishlist, deleteWishlist, exportWishlist,
  getWishlistItems, getWishlists, getPokedex, removeFromWishlist, transferWishlistItem,
  updateWishlist, updateWishlistItem,
} from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import CardImage from '../components/CardImage'
import PokeBallLoader from '../components/PokeBallLoader'
import TabNav from '../components/TabNav'
import { getEffectiveCardPrice } from '../utils/prices'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { normalizeSearchText } from '../utils/textSearch'
import toast from 'react-hot-toast'

const PURCHASE_RULES = [
  ['purchase_allowed', 'Purchase allowed'],
  ['open_or_trade_only', 'Open or trade only'],
  ['season_end_purchase', 'Season-end purchase'],
  ['parent_approval_required', 'Parent approval required'],
]

function normalizeDexIds(value) {
  const rawValues = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[;,\s]+/) : [value]
  return [...new Set(rawValues.map(Number).filter(id => Number.isInteger(id) && id > 0))]
}

function isPokemonCard(card) {
  return String(card?.category || card?.supertype || '').toLowerCase() === 'pokemon'
}

function WishlistActions({ item, onEdit, onRemove, onAddToCollection, t }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2" data-cart-action-area="wishlist-card">
      {/* BudgetCartButton is intentionally composed here after the wallet feature is integrated. */}
      <button type="button" className="btn-ghost min-h-10 py-1.5" onClick={onEdit} aria-label={t('wishlist.editCard')}><Edit2 size={15} /> {t('common.edit')}</button>
      {item.cardmarket_url && <a className="btn-ghost min-h-10 py-1.5" href={item.cardmarket_url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Cardmarket</a>}
      <button type="button" className="btn-ghost min-h-10 py-1.5" onClick={onAddToCollection}><Plus size={15} /> {t('wishlist.addToCollection')}</button>
      <button type="button" className="btn-ghost min-h-10 py-1.5 text-brand-red" onClick={onRemove} aria-label={t('wishlist.removeCard')}><Trash2 size={15} /> <span className="sr-only">{t('wishlist.removeCard')}</span></button>
    </div>
  )
}

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  setTimeout(() => {
    document.body.removeChild(anchor)
    window.URL.revokeObjectURL(url)
  }, 0)
}

function ListEditor({ list, onClose }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(list?.name || '')
  const [description, setDescription] = useState(list?.description || '')
  const [color, setColor] = useState(list?.color || '#EE1515')

  const mutation = useMutation({
    mutationFn: () => list
      ? updateWishlist(list.id, { name, description: description || null, color })
      : createWishlist({ name, description: description || null, color }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wishlists'] })
      toast.success(list ? 'Wishlist updated' : 'Wishlist created')
      onClose()
    },
  })

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-text-primary">{list ? 'Edit wishlist' : 'New wishlist'}</h2>
        <button type="button" className="btn-ghost p-2" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Wishlist name" maxLength={80} />
        <input className="input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description (optional)" maxLength={500} />
        <input className="h-10 w-14 rounded border border-border bg-bg-card" type="color" value={color} onChange={(event) => setColor(event.target.value)} />
      </div>
      <button type="button" className="btn-primary" disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>
        <Save size={15} /> {list ? 'Save' : 'Create'}
      </button>
    </div>
  )
}

function ItemEditor({ item, lists, onClose }) {
  const queryClient = useQueryClient()
  const [quantity, setQuantity] = useState(item.quantity || 1)
  const [variant, setVariant] = useState(item.desired_variant || 'Any')
  const [condition, setCondition] = useState(item.desired_condition || 'Any')
  const [priority, setPriority] = useState(item.priority || 0)
  const [purchaseRule, setPurchaseRule] = useState(item.purchase_rule || 'purchase_allowed')
  const [eligibleAfter, setEligibleAfter] = useState(item.eligible_after || '')
  const [labels, setLabels] = useState((item.purpose_labels || []).join(', '))
  const [notes, setNotes] = useState(item.notes || '')
  const [cardmarketUrl, setCardmarketUrl] = useState(item.cardmarket_url || '')
  const [targetList, setTargetList] = useState('')

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['wishlist-items'] })
    queryClient.invalidateQueries({ queryKey: ['wishlists'] })
    invalidateTcgdexFilterLanguages(queryClient)
  }

  const updateMutation = useMutation({
    mutationFn: () => updateWishlistItem(item.id, {
      quantity: Number(quantity),
      desired_variant: variant,
      desired_condition: condition,
      priority: Number(priority),
      purchase_rule: purchaseRule,
      eligible_after: eligibleAfter || null,
      purpose_labels: labels.split(',').map(label => label.trim()).filter(Boolean),
      notes: notes || null,
      cardmarket_url: cardmarketUrl || null,
    }),
    onSuccess: () => {
      refresh()
      toast.success('Wishlist item updated')
      onClose()
    },
  })

  const transferMutation = useMutation({
    mutationFn: (copy) => transferWishlistItem(item.id, Number(targetList), copy),
    onSuccess: (_, copy) => {
      refresh()
      toast.success(copy ? 'Copied to wishlist' : 'Moved to wishlist')
      if (!copy) onClose()
    },
  })

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-border bg-bg-elevated/50 p-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-xs text-text-muted">Quantity
          <input className="input mt-1 w-full" type="number" min="1" max="99" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
        </label>
        <label className="text-xs text-text-muted">Desired variant
          <select className="select mt-1 w-full" value={variant} onChange={(event) => setVariant(event.target.value)}>
            {['Any', 'Normal', 'Holo', 'Reverse Holo', 'First Edition'].map(value => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-muted">Minimum condition
          <select className="select mt-1 w-full" value={condition} onChange={(event) => setCondition(event.target.value)}>
            {['Any', 'Mint', 'NM', 'LP', 'MP', 'HP'].map(value => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-muted">Priority
          <select className="select mt-1 w-full" value={priority} onChange={(event) => setPriority(event.target.value)}>
            {[0, 1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value === 0 ? 'None' : `${value}/5`}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-muted">Purchase rule
          <select className="select mt-1 w-full" value={purchaseRule} onChange={(event) => setPurchaseRule(event.target.value)}>
            {PURCHASE_RULES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-muted">Eligible after
          <input className="input mt-1 w-full" type="date" value={eligibleAfter} onChange={(event) => setEligibleAfter(event.target.value)} />
        </label>
        <label className="text-xs text-text-muted sm:col-span-2">Purpose labels
          <input className="input mt-1 w-full" value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="National Pokédex, Kanto curated" />
        </label>
        <label className="text-xs text-text-muted sm:col-span-2">Cardmarket URL
          <input className="input mt-1 w-full" value={cardmarketUrl} onChange={(event) => setCardmarketUrl(event.target.value)} />
        </label>
        <label className="text-xs text-text-muted sm:col-span-2">Notes
          <input className="input mt-1 w-full" value={notes} onChange={(event) => setNotes(event.target.value)} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}><Check size={15} /> Save</button>
        <button type="button" className="btn-ghost" onClick={onClose}><X size={15} /> Cancel</button>
        <select className="select ml-auto min-w-44" value={targetList} onChange={(event) => setTargetList(event.target.value)}>
          <option value="">Move/copy to…</option>
          {lists.filter(list => list.id !== item.wishlist_id && !list.is_archived).map(list => <option key={list.id} value={list.id}>{list.name}</option>)}
        </select>
        <button type="button" className="btn-ghost" disabled={!targetList || transferMutation.isPending} onClick={() => transferMutation.mutate(false)}><MoveRight size={15} /> Move</button>
        <button type="button" className="btn-ghost" disabled={!targetList || transferMutation.isPending} onClick={() => transferMutation.mutate(true)}><Copy size={15} /> Copy</button>
      </div>
    </div>
  )
}

export default function Wishlist() {
  const { t, formatPrice, pricePrimaryField, settings } = useSettings()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState(null)
  const [editingList, setEditingList] = useState(null)
  const [creatingList, setCreatingList] = useState(false)
  const [editingItemId, setEditingItemId] = useState(null)
  const [affordableMax, setAffordableMax] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [speciesId, setSpeciesId] = useState('')
  const [viewMode, setViewMode] = useState(() => {
    const saved = window.localStorage.getItem('wishlist-view')
    if (saved === 'grid' || saved === 'list') return saved
    return window.matchMedia('(max-width: 767px)').matches ? 'grid' : 'list'
  })

  const listsQuery = useQuery({ queryKey: ['wishlists'], queryFn: getWishlists })
  const lists = listsQuery.data || []
  const activeList = lists.find(list => list.id === selectedId)
    || lists.find(list => list.is_default)
    || lists[0]

  const itemsQuery = useQuery({
    queryKey: ['wishlist-items', activeList?.id],
    queryFn: () => getWishlistItems(activeList.id),
    enabled: Boolean(activeList?.id),
  })
  const items = itemsQuery.data || []
  const language = settings.language === 'de' ? 'de' : 'en'
  const pokedexQuery = useQuery({
    queryKey: ['pokedex', 'wishlist-species', language],
    queryFn: () => getPokedex({ status: 'all', lang: language }),
    staleTime: 60 * 60 * 1000,
  })
  const speciesById = useMemo(() => new Map((pokedexQuery.data?.entries || []).map(entry => [entry.dex_id, language === 'de' ? entry.name_de : entry.name_en])), [pokedexQuery.data, language])
  const speciesOptions = useMemo(() => [...new Set(items
    .filter(item => isPokemonCard(item.card))
    .flatMap(item => normalizeDexIds(item.card?.dex_ids)))]
    .sort((a, b) => a - b)
    .map(id => ({ id, name: speciesById.get(id) || `#${String(id).padStart(3, '0')}` })), [items, speciesById])

  useEffect(() => { window.localStorage.setItem('wishlist-view', viewMode) }, [viewMode])
  useEffect(() => {
    if (speciesId && !speciesOptions.some(option => String(option.id) === speciesId)) setSpeciesId('')
  }, [activeList?.id, speciesId, speciesOptions])

  const visibleItems = useMemo(() => {
    const max = affordableMax === '' ? null : Number(affordableMax)
    const search = normalizeSearchText(searchTerm)
    const selectedSpecies = Number(speciesId)
    return [...items]
      .filter(item => {
        const card = item.card || {}
        const dexIds = normalizeDexIds(card.dex_ids)
        const speciesNames = dexIds.map(id => speciesById.get(id) || '')
        const searchable = [card.name, card.set_ref?.name, card.set_name, card.set_id, card.number, card.artist, ...speciesNames].map(normalizeSearchText).join(' ')
        if (search && !searchable.includes(search)) return false
        if (speciesId && (!isPokemonCard(card) || !dexIds.includes(selectedSpecies))) return false
        if (max == null || Number.isNaN(max)) return true
        const price = getEffectiveCardPrice(card, item.desired_variant === 'Any' ? null : item.desired_variant, pricePrimaryField)
        return price != null && price <= max
      })
      .sort((a, b) => (b.priority || 0) - (a.priority || 0) || String(a.card?.name || '').localeCompare(String(b.card?.name || '')))
  }, [items, affordableMax, pricePrimaryField, searchTerm, speciesId, speciesById])

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['wishlist-items'] })
    queryClient.invalidateQueries({ queryKey: ['wishlists'] })
    invalidateTcgdexFilterLanguages(queryClient)
  }

  const deleteListMutation = useMutation({
    mutationFn: deleteWishlist,
    onSuccess: () => {
      setSelectedId(null)
      refresh()
      toast.success('Wishlist deleted')
    },
  })
  const deleteItemMutation = useMutation({ mutationFn: removeFromWishlist, onSuccess: refresh })
  const collectionMutation = useMutation({
    mutationFn: (item) => addToCollection({ card_id: item.card_id, quantity: 1, condition: item.desired_condition === 'Any' ? 'NM' : item.desired_condition, variant: item.desired_variant === 'Any' ? 'Normal' : item.desired_variant, lang: item.card?.lang || 'en' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success(t('wishlist.addedToCollection'))
    },
  })

  const exportList = async (format) => {
    const blob = await exportWishlist(activeList.id, format)
    downloadBlob(blob, `${activeList.name}.${format}`)
  }

  const tabs = [
    { to: '/collection', label: t('nav.collection'), icon: Library },
    { to: '/wishlist', label: t('nav.wishlist'), icon: Heart, badge: activeList?.item_count || 0 },
  ]

  if (listsQuery.isLoading) return <div className="flex justify-center py-20"><PokeBallLoader size={48} /></div>

  return (
    <div className="space-y-4 pb-4">
      <TabNav tabs={tabs} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-text-primary"><Heart size={24} className="text-brand-red" /> Wishlists</h1>
          <p className="text-sm text-text-secondary">Separate shopping lists, acquisition rules and Cardmarket exports.</p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setCreatingList(true)}><Plus size={16} /> New wishlist</button>
      </div>

      {(creatingList || editingList) && <ListEditor list={editingList} onClose={() => { setCreatingList(false); setEditingList(null) }} />}

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <aside className="card h-fit space-y-2">
          {lists.map(list => (
            <button
              type="button"
              key={list.id}
              onClick={() => { setSelectedId(list.id); setEditingItemId(null) }}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${activeList?.id === list.id ? 'border-brand-red/60 bg-brand-red/10' : 'border-border bg-bg-card hover:bg-bg-elevated'}`}
            >
              <span className="h-8 w-2 rounded-full" style={{ backgroundColor: list.color || '#EE1515' }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-text-primary">{list.name}</span>
                <span className="text-xs text-text-muted">{list.item_count} cards · {list.copy_count} copies</span>
              </span>
              {list.is_archived && <Archive size={14} className="text-text-muted" />}
            </button>
          ))}
        </aside>

        <main className="space-y-4">
          {activeList && (
            <div className="card flex flex-wrap items-center gap-2">
              <div className="mr-auto min-w-0">
                <h2 className="truncate text-lg font-bold text-text-primary">{activeList.name}</h2>
                {activeList.description && <p className="text-sm text-text-muted">{activeList.description}</p>}
              </div>
              <label className="flex items-center gap-2 text-xs text-text-muted">Affordable under
                <input className="input w-24 py-1.5" type="number" min="0" step="0.01" value={affordableMax} onChange={(event) => setAffordableMax(event.target.value)} placeholder="€" />
              </label>
              <button type="button" className="btn-ghost" onClick={() => setEditingList(activeList)}><Edit2 size={15} /> Edit</button>
              <button type="button" className="btn-ghost" onClick={() => exportList('txt')}><Download size={15} /> Cardmarket</button>
              <button type="button" className="btn-ghost" onClick={() => exportList('csv')}><Download size={15} /> CSV</button>
              {!activeList.is_default && <button type="button" className="btn-ghost text-brand-red" onClick={() => window.confirm(`Delete ${activeList.name}?`) && deleteListMutation.mutate(activeList.id)}><Trash2 size={15} /></button>}
            </div>
          )}

          <section className="card space-y-3" aria-label={t('wishlist.filters')}>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,240px)_auto] sm:items-end">
              <label className="block text-xs text-text-muted">{t('wishlist.search')}
                <span className="relative mt-1 block"><Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" /><input className="input w-full pl-9" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder={t('wishlist.search')} /></span>
              </label>
              <label className="block text-xs text-text-muted">{t('wishlist.species')}
                <select className="select mt-1 w-full" value={speciesId} onChange={(event) => setSpeciesId(event.target.value)}>
                  <option value="">{t('wishlist.allSpecies')}</option>
                  {speciesOptions.map(option => <option key={option.id} value={option.id}>#{String(option.id).padStart(3, '0')} {option.name}</option>)}
                </select>
              </label>
              <div className="flex rounded-lg border border-border p-1" role="group" aria-label={t('wishlist.viewMode')}>
                <button type="button" className={`min-h-10 rounded-md px-3 ${viewMode === 'grid' ? 'bg-brand-red text-white' : 'text-text-muted'}`} onClick={() => setViewMode('grid')} aria-label={t('wishlist.gridView')} aria-pressed={viewMode === 'grid'}><Grid2X2 size={18} /></button>
                <button type="button" className={`min-h-10 rounded-md px-3 ${viewMode === 'list' ? 'bg-brand-red text-white' : 'text-text-muted'}`} onClick={() => setViewMode('list')} aria-label={t('wishlist.listView')} aria-pressed={viewMode === 'list'}><List size={18} /></button>
              </div>
            </div>
            <p className="text-sm font-medium text-text-secondary">{t('wishlist.resultCount').replace('{shown}', visibleItems.length).replace('{total}', items.length)}</p>
          </section>

          {itemsQuery.isLoading ? (
            <div className="flex justify-center py-20"><PokeBallLoader size={44} /></div>
          ) : visibleItems.length === 0 ? (
            <div className="card py-16 text-center text-text-muted">{items.length ? t('wishlist.noMatchingCards') : t('wishlist.empty')}</div>
          ) : (
            <div className={viewMode === 'grid' ? 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4' : 'space-y-3'}>
              {visibleItems.map(item => {
                const card = item.card || {}
                const price = getEffectiveCardPrice(card, item.desired_variant === 'Any' ? null : item.desired_variant, pricePrimaryField)
                const isEditing = editingItemId === item.id
                const metadata = <>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                    {item.priority > 0 && <span className="rounded-full bg-gold/10 px-2 py-1 text-gold">{t('wishlist.priority')} {item.priority}/5</span>}
                    <span className="rounded-full bg-bg-elevated px-2 py-1 text-text-secondary">{PURCHASE_RULES.find(([value]) => value === item.purchase_rule)?.[1] || item.purchase_rule}</span>
                    <span className="rounded-full bg-bg-elevated px-2 py-1 text-text-secondary">{item.desired_variant} · {item.desired_condition}</span>
                  </div>
                  <WishlistActions item={item} onEdit={() => setEditingItemId(isEditing ? null : item.id)} onRemove={() => window.confirm(t('wishlist.removeConfirm')) && deleteItemMutation.mutate(item.id)} onAddToCollection={() => collectionMutation.mutate(item)} t={t} />
                </>
                return viewMode === 'grid' ? (
                  <article key={item.id} className="card flex min-w-0 flex-col p-3">
                    <div className="aspect-[0.715] overflow-hidden rounded-lg bg-bg-elevated shadow-lg"><CardImage src={resolveCardImageUrl(card)} alt={card.name} className="h-full w-full object-cover" /></div>
                    <div className="mt-3 min-w-0"><h3 className="truncate font-bold text-text-primary">{card.name}</h3><p className="truncate text-xs text-text-muted">{card.set_ref?.name || card.set_id} · #{card.number}</p><div className="mt-2 flex items-center justify-between"><span className="font-bold text-gold">{price == null ? '—' : formatPrice(price)}</span><span className="text-xs text-text-muted">×{item.quantity}</span></div>{metadata}</div>
                    {isEditing && <ItemEditor item={item} lists={lists} onClose={() => setEditingItemId(null)} />}
                  </article>
                ) : (
                  <article key={item.id} className="card"><div className="flex gap-3"><div className="h-32 w-24 shrink-0 overflow-hidden rounded-lg bg-bg-elevated"><CardImage src={resolveCardImageUrl(card)} alt={card.name} className="h-full w-full object-cover" /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-bold text-text-primary">{card.name}</h3><p className="text-xs text-text-muted">{card.set_ref?.name || card.set_id} · #{card.number} · {card.lang?.toUpperCase()}</p></div><div className="text-right"><p className="font-bold text-gold">{price == null ? '—' : formatPrice(price)}</p><p className="text-xs text-text-muted">×{item.quantity}</p></div></div>{metadata}</div></div>{isEditing && <ItemEditor item={item} lists={lists} onClose={() => setEditingItemId(null)} />}</article>
                )
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
