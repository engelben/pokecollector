import { useState } from 'react'
import { ShoppingCart, Trash2, Send, HelpCircle, Minus, Plus } from 'lucide-react'
import toast from 'react-hot-toast'
import { getCard, submitBudgetCart } from '../api/client'
import { useBudgetCart } from '../hooks/useBudgetCart'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Sheet from './ui/Sheet'
import CardImage from './CardImage'
import { CardModal } from './CardItem'
import { resolveCardImageUrl } from '../utils/imageUrl'
const money = (cents, currency = 'EUR') => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100)
function Progress({ cart, currency }) {
  const subtotal = cart.priced_subtotal_cents || 0; const balance = cart.balance_cents || 0
  const usage = balance ? subtotal / balance : (subtotal ? Infinity : 0)
  const over = usage > 1; const warning = usage >= .8
  const color = over ? 'bg-brand-red' : warning ? 'bg-orange-500' : subtotal ? 'bg-green' : 'bg-text-muted'
  return <div className="space-y-1"><div className="flex justify-between text-xs"><span>Cart: {money(subtotal, currency)}</span><span className={over ? 'text-brand-red font-bold' : ''}>{over ? `Over: ${money(cart.over_budget_cents, currency)}` : `Left: ${money(cart.remaining_cents, currency)}`}</span></div><div className="h-2 overflow-hidden rounded-full bg-bg-elevated"><div className={`h-full ${color}`} style={{ width: `${Math.min(100, usage * 100)}%` }} /></div>{cart.unknown_price_count > 0 && <p className="flex items-center gap-1 text-xs text-orange-400"><HelpCircle size={13} /> Total is incomplete: {cart.unknown_price_count} unpriced card(s).</p>}</div>
}
export default function BudgetCart({ summary, userId = null }) {
  const [open, setOpen] = useState(false); const [selectedCardId, setSelectedCardId] = useState(null); const queryClient = useQueryClient()
  const { cart: fetched, remove, setQuantity, isMutating } = useBudgetCart(Boolean(summary?.enabled))
  const selectedCard = useQuery({ queryKey: ['card', selectedCardId], queryFn: () => getCard(selectedCardId).then(response => response.data), enabled: Boolean(selectedCardId) })
  const submit = useMutation({ mutationFn: () => submitBudgetCart(userId), onSuccess: () => { toast.success('Cart saved as a purchase basket'); queryClient.invalidateQueries({ queryKey: ['budget-cart'] }); queryClient.invalidateQueries({ queryKey: ['budget-plans'] }); setOpen(false) } })
  if (!summary?.enabled) return null
  const cart = fetched || { item_count: 0, items: [], priced_subtotal_cents: 0, balance_cents: summary.account?.balance_cents || 0, remaining_cents: summary.account?.balance_cents || 0, over_budget_cents: 0, unknown_price_count: 0 }
  const currency = summary.account?.currency
  return <><button type="button" onClick={() => setOpen(true)} className="fixed bottom-[calc(var(--mobile-nav-height,4rem)+var(--mobile-nav-raised-extension,1.5rem)+env(safe-area-inset-bottom)+12px)] right-4 z-40 flex items-center gap-2 rounded-full bg-brand-red px-4 py-3 font-bold text-white shadow-lg" aria-label="Open shopping cart"><ShoppingCart size={19} /><span>{cart.item_count}</span></button>
    <aside className="fixed bottom-[calc(var(--mobile-nav-height,4rem)+var(--mobile-nav-raised-extension,1.5rem)+env(safe-area-inset-bottom)+12px)] left-4 z-40 hidden w-60 rounded-xl border border-border bg-bg-card/95 p-3 shadow-lg backdrop-blur sm:block"><div className="mb-2 text-xs font-bold">Available: {money(cart.balance_cents, currency)}</div><Progress cart={cart} currency={currency} /></aside>
    <Sheet isOpen={open} onClose={() => setOpen(false)} title="Shopping cart"><div className="space-y-3 p-4">{!cart.items.length ? <p className="py-8 text-center text-text-muted">Your cart is empty. Add cards while browsing.</p> : <>{cart.items.map(item => <div key={item.card_id} className="flex items-center gap-3 rounded-lg border border-border p-2"><button type="button" onClick={() => setSelectedCardId(item.card_id)} className="h-[68px] w-12 shrink-0 overflow-hidden rounded-lg bg-bg-elevated ring-1 ring-white/5 hover:ring-brand-red/50" aria-label={`View ${item.name} details`}><CardImage src={resolveCardImageUrl(item)} alt={item.name} className="h-full w-full object-cover" /></button><div className="min-w-0 flex-1"><button type="button" onClick={() => setSelectedCardId(item.card_id)} className="block w-full text-left group"><p className="truncate font-medium group-hover:text-brand-red">{item.name}</p><p className="truncate text-xs text-text-muted">{item.set_name}</p></button><div className="mt-1 inline-flex items-center gap-2 rounded-full border border-border bg-bg-surface px-2 py-1"><button type="button" onClick={() => item.quantity === 1 ? remove.mutate(item.card_id) : setQuantity.mutate({ card_id: item.card_id, quantity: item.quantity - 1 })} disabled={isMutating} className="text-text-muted hover:text-text-primary" aria-label={`Decrease ${item.name} quantity`}><Minus size={12} /></button><span className="min-w-5 text-center text-xs font-semibold">{item.quantity}</span><button type="button" onClick={() => setQuantity.mutate({ card_id: item.card_id, quantity: item.quantity + 1 })} disabled={isMutating || item.quantity >= 99} className="text-text-muted hover:text-text-primary" aria-label={`Increase ${item.name} quantity`}><Plus size={12} /></button></div></div><span className="text-sm font-bold text-gold">{item.price_cents == null ? '?' : money(item.line_total_cents, currency)}</span><button type="button" onClick={() => remove.mutate(item.card_id)} className="text-text-muted hover:text-brand-red" aria-label={`Remove ${item.name}`}><Trash2 size={16} /></button></div>)}<Progress cart={cart} currency={currency}/><button type="button" className="btn-primary w-full" onClick={() => submit.mutate()} disabled={submit.isPending || isMutating}><Send size={16} /> Save basket for approval</button></>}</div></Sheet>
    {selectedCard.data && <CardModal card={selectedCard.data} onClose={() => setSelectedCardId(null)} />}</>
}
