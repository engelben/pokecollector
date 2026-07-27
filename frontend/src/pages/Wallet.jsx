import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Check, Coins, Gift, PiggyBank, Plus, ShoppingBasket, WalletCards } from 'lucide-react'
import {
  addBudgetLedgerEntry, confirmBudgetPlan, createBudgetPlan, getBudgetLedger,
  getBudgetPlans, getBudgetSuggestions, getBudgetSummary, getBudgetWishlistSources,
  submitBudgetPlan, upsertBudgetAccount,
} from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import PokeBallLoader from '../components/PokeBallLoader'
import toast from 'react-hot-toast'

const BUCKETS = [
  ['affordable_now', 'Affordable now'],
  ['almost_affordable', 'Almost affordable'],
  ['parent_approval', 'Parent approval required'],
  ['season_end', 'Available at season end'],
  ['open_or_trade_only', 'Open or trade only'],
  ['no_price', 'No current price'],
]

function money(cents, currency = 'EUR') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100)
}

function AccountEditor({ account, userId, wishlistSources, onSaved }) {
  const [weekly, setWeekly] = useState(((account?.weekly_credit_cents ?? 500) / 100).toFixed(2))
  const [nextDate, setNextDate] = useState(account?.next_credit_date || new Date().toISOString().slice(0, 10))
  const [enabled, setEnabled] = useState(account?.credit_enabled ?? true)
  const [parentShipping, setParentShipping] = useState(account?.parent_covers_shipping ?? true)
  const [sourceIds, setSourceIds] = useState(account?.source_wishlist_ids || [])

  useEffect(() => {
    setWeekly(((account?.weekly_credit_cents ?? 500) / 100).toFixed(2))
    setNextDate(account?.next_credit_date || new Date().toISOString().slice(0, 10))
    setEnabled(account?.credit_enabled ?? true)
    setParentShipping(account?.parent_covers_shipping ?? true)
    setSourceIds(account?.source_wishlist_ids || [])
  }, [account?.id, account?.updated_at, userId])

  const mutation = useMutation({
    mutationFn: () => upsertBudgetAccount({
      user_id: account?.user_id || userId,
      currency: account?.currency || 'EUR',
      weekly_credit_cents: Math.round(Number(weekly || 0) * 100),
      next_credit_date: nextDate,
      credit_enabled: enabled,
      source_wishlist_ids: sourceIds,
      parent_covers_shipping: parentShipping,
    }),
    onSuccess: () => { toast.success('Wallet settings saved'); onSaved() },
  })

  const lists = wishlistSources?.lists || []
  const toggleSource = (id) => setSourceIds(current => current.includes(id)
    ? current.filter(value => value !== id)
    : [...current, id])

  return (
    <div className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className="text-xs text-text-muted">Weekly allowance
        <input className="input mt-1 w-full" type="number" min="0" step="0.01" value={weekly} onChange={(event) => setWeekly(event.target.value)} />
      </label>
      <label className="text-xs text-text-muted">Next allowance
        <input className="input mt-1 w-full" type="date" value={nextDate} onChange={(event) => setNextDate(event.target.value)} />
      </label>
      <label className="mt-6 flex items-center gap-2 text-sm text-text-secondary">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Automatic weekly credit
      </label>
      <label className="mt-6 flex items-center gap-2 text-sm text-text-secondary">
        <input type="checkbox" checked={parentShipping} onChange={(event) => setParentShipping(event.target.checked)} /> Parent covers shipping by default
      </label>
      <div className="sm:col-span-2 lg:col-span-4">
        <p className="mb-2 text-xs text-text-muted">Wishlist sources</p>
        {!wishlistSources?.multiple_wishlists ? (
          <p className="text-sm text-text-secondary">All wishlist items are used. Named source selection becomes available with the multiple-wishlists feature.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <label className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs ${sourceIds.length === 0 ? 'border-gold/60 bg-gold/10 text-gold' : 'border-border text-text-secondary'}`}>
              <input className="sr-only" type="checkbox" checked={sourceIds.length === 0} onChange={() => setSourceIds([])} /> All wishlists
            </label>
            {lists.filter(list => !list.is_archived).map(list => (
              <label key={list.id} className={`cursor-pointer rounded-full border px-3 py-1.5 text-xs ${sourceIds.includes(list.id) ? 'border-brand-red/60 bg-brand-red/10 text-brand-red' : 'border-border text-text-secondary'}`}>
                <input className="sr-only" type="checkbox" checked={sourceIds.includes(list.id)} onChange={() => toggleSource(list.id)} /> {list.name}
              </label>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="btn-primary sm:col-span-2 lg:col-span-4" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        <Check size={15} /> Save wallet settings
      </button>
    </div>
  )
}

function AdjustmentForm({ userId, onSaved }) {
  const [amount, setAmount] = useState('5.00')
  const [type, setType] = useState('gift')
  const [note, setNote] = useState('')
  const mutation = useMutation({
    mutationFn: () => addBudgetLedgerEntry({
      user_id: userId,
      amount_cents: Math.round(Number(amount || 0) * 100),
      entry_type: type,
      effective_date: new Date().toISOString().slice(0, 10),
      note: note || null,
    }),
    onSuccess: () => { toast.success('Wallet adjusted'); setNote(''); onSaved() },
  })
  return (
    <div className="card flex flex-wrap items-end gap-3">
      <label className="text-xs text-text-muted">Amount
        <input className="input mt-1 w-28" type="number" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} />
      </label>
      <label className="text-xs text-text-muted">Type
        <select className="select mt-1" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="gift">Gift</option>
          <option value="parent_adjustment">Parent adjustment</option>
          <option value="refund">Refund</option>
          <option value="correction">Correction</option>
        </select>
      </label>
      <label className="min-w-48 flex-1 text-xs text-text-muted">Note
        <input className="input mt-1 w-full" value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button type="button" className="btn-primary" onClick={() => mutation.mutate()} disabled={!Number(amount) || mutation.isPending}><Gift size={15} /> Add entry</button>
    </div>
  )
}

function PlanCard({ plan, currency, canManage, onChanged }) {
  const [shipping, setShipping] = useState('0.00')
  const [chargeShipping, setChargeShipping] = useState(false)
  const [prices, setPrices] = useState(() => Object.fromEntries(plan.items.map(item => [item.id, ((item.actual_unit_price_cents ?? item.estimated_unit_price_cents ?? 0) / 100).toFixed(2)])))
  const submitMutation = useMutation({ mutationFn: () => submitBudgetPlan(plan.id, {}), onSuccess: onChanged })
  const confirmMutation = useMutation({
    mutationFn: () => confirmBudgetPlan(plan.id, {
      items: plan.items.map(item => ({ item_id: item.id, actual_unit_price_cents: Math.round(Number(prices[item.id] || 0) * 100) })),
      shipping_cents: Math.round(Number(shipping || 0) * 100),
      charge_shipping_to_wallet: chargeShipping,
    }),
    onSuccess: () => { toast.success('Purchase confirmed'); onChanged() },
  })
  return (
    <article className="card space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div><h3 className="font-bold text-text-primary">Basket #{plan.id}</h3><p className="text-xs text-text-muted">{plan.status.replaceAll('_', ' ')}</p></div>
        <p className="font-bold text-gold">{money(plan.actual_card_total_cents ?? plan.estimated_card_total_cents, currency)}</p>
      </div>
      <div className="space-y-2">
        {plan.items.map(item => (
          <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-bg-elevated/50 p-2">
            <span className="min-w-0 flex-1 text-sm text-text-primary">{item.card_name_snapshot} <span className="text-text-muted">· {item.set_name_snapshot}</span></span>
            {canManage && ['draft', 'pending_approval'].includes(plan.status) ? (
              <input className="input w-24 py-1.5" type="number" step="0.01" min="0" value={prices[item.id]} onChange={(event) => setPrices(current => ({ ...current, [item.id]: event.target.value }))} />
            ) : <span className="text-sm text-gold">{money(item.actual_unit_price_cents ?? item.estimated_unit_price_cents, currency)}</span>}
          </div>
        ))}
      </div>
      {plan.status === 'draft' && !canManage && <button type="button" className="btn-primary" onClick={() => submitMutation.mutate()}><ShoppingBasket size={15} /> Request parent approval</button>}
      {canManage && ['draft', 'pending_approval'].includes(plan.status) && (
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <label className="text-xs text-text-muted">Shipping
            <input className="input mt-1 w-24 py-1.5" type="number" min="0" step="0.01" value={shipping} onChange={(event) => setShipping(event.target.value)} />
          </label>
          <label className="mb-2 flex items-center gap-2 text-xs text-text-secondary"><input type="checkbox" checked={chargeShipping} onChange={(event) => setChargeShipping(event.target.checked)} /> Charge shipping to wallet</label>
          <button type="button" className="btn-primary ml-auto" onClick={() => confirmMutation.mutate()} disabled={confirmMutation.isPending}><Check size={15} /> Confirm purchase</button>
        </div>
      )}
    </article>
  )
}

export default function Wallet() {
  const { user, profiles, actorUserId } = useAuth()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState([])
  const canManage = !user?.managed_profile && user?.id === actorUserId
  const [targetUserId, setTargetUserId] = useState(user?.id || null)
  const queryUserId = canManage ? targetUserId : null
  const summaryQuery = useQuery({ queryKey: ['budget-summary', queryUserId], queryFn: () => getBudgetSummary(queryUserId), enabled: Boolean(user && (!canManage || queryUserId)) })
  const account = summaryQuery.data?.account
  const enabled = summaryQuery.data?.enabled
  const ledgerQuery = useQuery({ queryKey: ['budget-ledger', queryUserId], queryFn: () => getBudgetLedger(queryUserId), enabled })
  const suggestionsQuery = useQuery({ queryKey: ['budget-suggestions', queryUserId], queryFn: () => getBudgetSuggestions(queryUserId), enabled })
  const plansQuery = useQuery({ queryKey: ['budget-plans', queryUserId], queryFn: () => getBudgetPlans(queryUserId), enabled })
  const wishlistSourcesQuery = useQuery({ queryKey: ['budget-wishlist-sources', queryUserId], queryFn: () => getBudgetWishlistSources(queryUserId), enabled: Boolean(canManage && queryUserId) })

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['budget-summary'] })
    queryClient.invalidateQueries({ queryKey: ['budget-ledger'] })
    queryClient.invalidateQueries({ queryKey: ['budget-suggestions'] })
    queryClient.invalidateQueries({ queryKey: ['budget-plans'] })
    queryClient.invalidateQueries({ queryKey: ['budget-wishlist-sources'] })
  }

  const createPlanMutation = useMutation({
    mutationFn: () => createBudgetPlan({ user_id: queryUserId, wishlist_item_ids: selected }),
    onSuccess: () => { setSelected([]); refresh(); toast.success('Basket created') },
  })

  const grouped = useMemo(() => {
    const map = new Map(BUCKETS.map(([key]) => [key, []]))
    for (const item of suggestionsQuery.data || []) (map.get(item.bucket) || map.get('no_price')).push(item)
    return map
  }, [suggestionsQuery.data])

  if (summaryQuery.isLoading) return <div className="flex justify-center py-20"><PokeBallLoader size={48} /></div>

  const profileSelector = canManage && profiles?.length > 1 ? (
    <label className="flex items-center gap-2 text-sm text-text-muted">Collector
      <select className="select" value={targetUserId || ''} onChange={(event) => { setTargetUserId(Number(event.target.value)); setSelected([]) }}>
        {profiles.filter(profile => profile.is_active !== false).map(profile => <option key={profile.id} value={profile.id}>{profile.username}</option>)}
      </select>
    </label>
  ) : null

  if (!enabled) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {profileSelector}
        <div className="card py-16 text-center">
          <PiggyBank size={52} className="mx-auto mb-4 text-gold" />
          <h1 className="text-2xl font-bold text-text-primary">Allowance wallet</h1>
          <p className="mx-auto mt-2 max-w-lg text-text-muted">Track weekly allowance, gifts, purchases and affordable wishlist cards separately from the wishlists themselves.</p>
        </div>
        {canManage ? <AccountEditor account={null} userId={targetUserId} wishlistSources={wishlistSourcesQuery.data} onSaved={refresh} /> : <p className="text-center text-sm text-text-muted">The managing profile has not enabled a wallet yet.</p>}
      </div>
    )
  }

  const currency = account.currency || 'EUR'
  return (
    <div className="space-y-5 pb-5">
      <div className="flex justify-end">{profileSelector}</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card"><div className="flex items-center gap-2 text-text-muted"><WalletCards size={18} /> Available</div><p className="mt-2 text-3xl font-black text-gold">{money(account.balance_cents, currency)}</p></div>
        <div className="card"><div className="flex items-center gap-2 text-text-muted"><CalendarDays size={18} /> Next allowance</div><p className="mt-2 text-xl font-bold text-text-primary">{account.next_credit_date || 'Paused'}</p><p className="text-sm text-green">+{money(account.weekly_credit_cents, currency)}</p></div>
        <div className="card"><div className="flex items-center gap-2 text-text-muted"><Coins size={18} /> Affordable now</div><p className="mt-2 text-3xl font-black text-text-primary">{account.affordable_count}</p><p className="text-sm text-text-muted">wishlist cards</p></div>
      </div>

      {canManage && <><AccountEditor account={account} userId={targetUserId} wishlistSources={wishlistSourcesQuery.data} onSaved={refresh} /><AdjustmentForm userId={account.user_id} onSaved={refresh} /></>}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-bold text-text-primary">Wishlist suggestions</h2><button type="button" className="btn-primary" disabled={!selected.length || createPlanMutation.isPending} onClick={() => createPlanMutation.mutate()}><ShoppingBasket size={15} /> Create basket ({selected.length})</button></div>
        {BUCKETS.map(([bucket, label]) => {
          const rows = grouped.get(bucket) || []
          if (!rows.length) return null
          return <div key={bucket} className="card space-y-2"><h3 className="font-semibold text-text-secondary">{label}</h3>{rows.map(item => {
            const selectable = ['affordable_now', 'almost_affordable', 'parent_approval'].includes(item.bucket)
            return <label key={item.wishlist_item_id} className="flex items-center gap-3 rounded-lg border border-border bg-bg-card p-2">
              <input type="checkbox" disabled={!selectable} checked={selected.includes(item.wishlist_item_id)} onChange={(event) => setSelected(current => event.target.checked ? [...current, item.wishlist_item_id] : current.filter(id => id !== item.wishlist_item_id))} />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium text-text-primary">{item.name}</span><span className="text-xs text-text-muted">{item.set_name} · #{item.number}</span></span>
              <span className="text-right"><span className="block font-bold text-gold">{item.price_cents == null ? '—' : money(item.price_cents, currency)}</span>{item.shortfall_cents > 0 && <span className="text-xs text-text-muted">save {money(item.shortfall_cents, currency)}</span>}</span>
            </label>
          })}</div>
        })}
      </section>

      <section className="space-y-3"><h2 className="text-lg font-bold text-text-primary">Purchase baskets</h2>{(plansQuery.data || []).length ? (plansQuery.data || []).map(plan => <PlanCard key={plan.id} plan={plan} currency={currency} canManage={canManage} onChanged={refresh} />) : <div className="card text-text-muted">No baskets yet.</div>}</section>

      <section className="space-y-3"><h2 className="text-lg font-bold text-text-primary">Transaction history</h2><div className="card divide-y divide-border">{(ledgerQuery.data || []).map(row => <div key={row.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"><span className={`font-bold ${row.amount_cents >= 0 ? 'text-green' : 'text-brand-red'}`}>{row.amount_cents >= 0 ? '+' : ''}{money(row.amount_cents, currency)}</span><span className="min-w-0 flex-1"><span className="block text-sm text-text-primary">{row.entry_type.replaceAll('_', ' ')}</span><span className="text-xs text-text-muted">{row.note || row.effective_date}</span></span><span className="text-xs text-text-muted">{row.effective_date}</span></div>)}</div></section>
    </div>
  )
}
