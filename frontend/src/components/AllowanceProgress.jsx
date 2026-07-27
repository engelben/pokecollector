import { PiggyBank } from 'lucide-react'

const money = (cents, currency = 'EUR') => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100)

/** A small sticky balance indicator; balances always originate from the ledger API. */
export default function AllowanceProgress({ summary }) {
  const account = summary?.account
  if (!summary?.enabled || !account) return null
  const weekly = Math.max(account.weekly_credit_cents || 0, 1)
  const progress = Math.min(100, Math.max(0, (account.balance_cents / weekly) * 100))
  return <aside className="fixed bottom-5 left-5 z-40 hidden w-56 rounded-xl border border-gold/30 bg-bg-card/95 p-3 shadow-lg backdrop-blur sm:block" aria-label="Allowance progress">
    <div className="flex items-center justify-between text-xs text-text-muted"><span className="flex items-center gap-1"><PiggyBank size={15} className="text-gold" /> Allowance</span><strong className="text-gold">{money(account.balance_cents, account.currency)}</strong></div>
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-bg-elevated"><div className="h-full rounded-full bg-gold transition-all" style={{ width: `${progress}%` }} /></div>
    <p className="mt-1 text-[11px] text-text-muted">Next credit: {account.next_credit_date || 'paused'}</p>
  </aside>
}
