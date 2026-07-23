import { Minus, Plus, ShoppingBasket } from 'lucide-react'
import { useBudgetCart } from '../hooks/useBudgetCart'

export default function BudgetCartButton({ cardId, enabled = true }) {
  const { cartItemByCardId, add, setQuantity, remove, isMutating } = useBudgetCart(enabled)
  if (!enabled) return null
  const item = cartItemByCardId.get(cardId)
  const stop = fn => event => { event.preventDefault(); event.stopPropagation(); fn() }
  if (!item) return <button type="button" aria-label="Add card to cart" disabled={isMutating} onClick={stop(() => add.mutate(cardId))} className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg bg-brand-red text-white shadow disabled:opacity-50"><ShoppingBasket size={19} /><Plus size={12} /></button>
  return <div className="inline-flex min-h-10 items-center rounded-lg bg-bg-elevated shadow" onClick={e => e.stopPropagation()}>
    <button type="button" aria-label="Remove one from cart" disabled={isMutating} onClick={stop(() => item.quantity === 1 ? remove.mutate(cardId) : setQuantity.mutate({ card_id: cardId, quantity: item.quantity - 1 }))} className="min-h-10 min-w-10 text-text-primary disabled:opacity-50"><Minus size={16} /></button>
    <span className="min-w-6 text-center text-sm font-bold">{item.quantity}</span>
    <button type="button" aria-label="Add one to cart" disabled={isMutating || item.quantity >= 99} onClick={stop(() => setQuantity.mutate({ card_id: cardId, quantity: item.quantity + 1 }))} className="min-h-10 min-w-10 text-brand-red disabled:opacity-50"><Plus size={16} /></button>
  </div>
}
