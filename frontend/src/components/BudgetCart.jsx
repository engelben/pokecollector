import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShoppingCart, Trash2, Send } from 'lucide-react'
import toast from 'react-hot-toast'
import { getBudgetCart, removeBudgetCartItem, submitBudgetCart } from '../api/client'
import Sheet from './ui/Sheet'

const money = (cents, currency = 'EUR') => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100)

/** Global cart button + drawer. It remains absent until a wallet is enabled. */
export default function BudgetCart({ summary, userId = null }) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const cartQuery = useQuery({ queryKey: ['budget-cart', userId], queryFn: () => getBudgetCart(userId), enabled: Boolean(summary?.enabled) })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['budget-cart'] })
  const remove = useMutation({ mutationFn: id => removeBudgetCartItem(id, userId), onSuccess: refresh })
  const submit = useMutation({ mutationFn: () => submitBudgetCart(userId), onSuccess: () => { toast.success('Cart saved as a purchase basket'); refresh(); queryClient.invalidateQueries({ queryKey: ['budget-plans'] }); setOpen(false) } })
  if (!summary?.enabled) return null
  const cart = cartQuery.data || { item_count: 0, items: [], estimated_total_cents: 0 }
  return <>
    <button type="button" onClick={() => setOpen(true)} className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-brand-red px-4 py-3 font-bold text-white shadow-lg transition-transform hover:scale-105" aria-label="Open shopping cart">
      <ShoppingCart size={19} /> <span>{cart.item_count}</span>
    </button>
    <Sheet isOpen={open} onClose={() => setOpen(false)} title="Wishlist cart">
      <div className="space-y-3 p-4">
        {!cart.items.length ? <p className="py-8 text-center text-text-muted">Your cart is empty. Add cards from your wishlist.</p> : <>
          {cart.items.map(item => <div key={item.id} className="flex items-center gap-3 rounded-lg border border-border p-2">
            <div className="min-w-0 flex-1"><p className="truncate font-medium text-text-primary">{item.name}</p><p className="text-xs text-text-muted">{item.set_name} · Qty {item.quantity}</p></div>
            <span className="text-sm font-bold text-gold">{item.price_cents == null ? '—' : money(item.line_total_cents, summary.account?.currency)}</span>
            <button type="button" onClick={() => remove.mutate(item.wishlist_item_id)} className="text-text-muted hover:text-brand-red" aria-label={`Remove ${item.name}`}><Trash2 size={16} /></button>
          </div>)}
          <div className="flex items-center justify-between border-t border-border pt-3 font-bold"><span>Estimated total</span><span className="text-gold">{money(cart.estimated_total_cents, summary.account?.currency)}</span></div>
          <button type="button" className="btn-primary w-full" onClick={() => submit.mutate()} disabled={submit.isPending}><Send size={16} /> Save basket for approval</button>
        </>}
      </div>
    </Sheet>
  </>
}
