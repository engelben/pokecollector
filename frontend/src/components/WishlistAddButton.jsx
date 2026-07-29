import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Heart, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { addToWishlist, getWishlists } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'

export function buildWishlistPayload({ card, quantity, variant, condition, wishlistId }) {
  return {
    card_id: card.id,
    quantity: Math.max(1, Math.min(99, Number(quantity) || 1)),
    desired_variant: variant || 'Any',
    desired_condition: condition || 'Any',
    ...(wishlistId ? { wishlist_id: Number(wishlistId) } : {}),
  }
}

/** Add a card with the choices already made in its action modal. */
export default function WishlistAddButton({
  card,
  quantity = 1,
  variant = 'Any',
  condition = 'Any',
  className,
  iconSize = 18,
  onAdded,
  children,
}) {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [selecting, setSelecting] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const { data: allWishlists = [], isLoading } = useQuery({ queryKey: ['wishlists'], queryFn: getWishlists })
  const wishlists = allWishlists.filter(list => !list.is_archived)

  useEffect(() => {
    if (!selecting) return
    setSelectedId(String(wishlists.find(list => list.is_default)?.id || wishlists[0]?.id || ''))
  }, [selecting, wishlists])

  const mutation = useMutation({
    mutationFn: (wishlistId) => addToWishlist(buildWishlistPayload({ card, quantity, variant, condition, wishlistId })),
    onSuccess: () => {
      toast.success(`${card.name} ${t('card.addedToWishlist')}`)
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      setSelecting(false)
      onAdded?.()
    },
    onError: () => toast.error(t('card.wishlistFailed')),
  })

  const add = (event) => {
    event.stopPropagation()
    if (wishlists.length > 1) setSelecting(true)
    else mutation.mutate(wishlists[0]?.id)
  }

  return <>
    <button type="button" className={className} onClick={add} disabled={isLoading || mutation.isPending} aria-label={t('wishlist.addToList')}>
      <Heart size={iconSize} />{children}
    </button>
    {selecting && createPortal(
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setSelecting(false)}
      >
        <div className="card w-full max-w-sm space-y-4" role="dialog" aria-modal="true" aria-labelledby="wishlist-picker-title" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-3">
            <h2 id="wishlist-picker-title" className="font-bold text-text-primary">{t('wishlist.chooseList')}</h2>
            <button type="button" className="btn-ghost p-2" onClick={() => setSelecting(false)} aria-label={t('common.close')}><X size={20} /></button>
          </div>
          <div className="space-y-2" role="radiogroup" aria-label={t('wishlist.lists')}>
            {wishlists.map(list => {
              const selected = selectedId === String(list.id)
              return <button
                key={list.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${selected ? 'border-brand-red bg-brand-red/10' : 'border-border bg-bg-card hover:bg-bg-elevated'}`}
                onClick={() => setSelectedId(String(list.id))}
              >
                <span className="h-8 w-2 rounded-full" style={{ backgroundColor: list.color || '#EE1515' }} />
                <span className="min-w-0 flex-1 truncate font-semibold text-text-primary">{list.name}</span>
                {selected && <Check size={20} className="shrink-0 text-brand-red" />}
              </button>
            })}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setSelecting(false)}>{t('common.cancel')}</button>
            <button type="button" className="btn-primary" disabled={!selectedId || mutation.isPending} onClick={() => mutation.mutate(selectedId)}><Heart size={18} /> {t('wishlist.addToList')}</button>
          </div>
        </div>
      </div>, document.body)}
  </>
}
