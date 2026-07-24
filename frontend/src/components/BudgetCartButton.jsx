import { Minus, Plus, ShoppingBasket } from 'lucide-react'
import { useBudgetCart } from '../hooks/useBudgetCart'
import { useSettings } from '../contexts/SettingsContext'

export default function BudgetCartButton({ cardId, enabled = true, modal = false }) {
  const { t } = useSettings()
  const { cartItemByCardId, add, setQuantity, remove, isMutating } = useBudgetCart(enabled)
  if (!enabled) return null
  const item = cartItemByCardId.get(cardId)
  const stop = fn => event => { event.preventDefault(); event.stopPropagation(); fn() }
  const disabled = isMutating
  if (!item) return <button type="button" aria-label={t('allowanceCart.addToCart')} disabled={disabled} onClick={stop(() => add.mutate(cardId))} className={modal ? 'btn-ghost flex-1 min-h-10 justify-center text-brand-red' : 'inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg bg-brand-red text-white shadow disabled:opacity-50'}><ShoppingBasket size={modal ? 16 : 19} />{modal && <span>{disabled ? t('common.loading') : t('allowanceCart.addToCart')}</span>}{!modal && <Plus size={12} />}</button>
  if (modal) return <div className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-green/30 bg-green/10 px-1 text-green" aria-label={t('allowanceCart.inCart')}><button type="button" aria-label={t('allowanceCart.decreaseQuantity')} disabled={disabled} onClick={stop(() => item.quantity === 1 ? remove.mutate(cardId) : setQuantity.mutate({ card_id: cardId, quantity: item.quantity - 1 }))} className="min-h-10 min-w-8 disabled:opacity-50"><Minus size={16} /></button><span className="whitespace-nowrap text-xs font-bold">{t('allowanceCart.inCart')} ({item.quantity})</span><button type="button" aria-label={t('allowanceCart.increaseQuantity')} disabled={disabled || item.quantity >= 99} onClick={stop(() => setQuantity.mutate({ card_id: cardId, quantity: item.quantity + 1 }))} className="min-h-10 min-w-8 disabled:opacity-50"><Plus size={16} /></button></div>
  return <div className="inline-flex min-h-10 items-center rounded-lg bg-bg-elevated shadow" onClick={e => e.stopPropagation()}><button type="button" aria-label={t('allowanceCart.decreaseQuantity')} disabled={disabled} onClick={stop(() => item.quantity === 1 ? remove.mutate(cardId) : setQuantity.mutate({ card_id: cardId, quantity: item.quantity - 1 }))} className="min-h-10 min-w-10 text-text-primary disabled:opacity-50"><Minus size={16} /></button><span className="min-w-6 text-center text-sm font-bold">{item.quantity}</span><button type="button" aria-label={t('allowanceCart.increaseQuantity')} disabled={disabled || item.quantity >= 99} onClick={stop(() => setQuantity.mutate({ card_id: cardId, quantity: item.quantity + 1 }))} className="min-h-10 min-w-10 text-brand-red disabled:opacity-50"><Plus size={16} /></button></div>
}
