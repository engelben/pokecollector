import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { CalendarDays, Coins, PiggyBank } from 'lucide-react'
import { getBudgetSummary } from '../api/client'

function money(cents, currency = 'EUR') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100)
}

export default function BudgetDashboardCard() {
  const navigate = useNavigate()
  const { data } = useQuery({
    queryKey: ['budget-summary'],
    queryFn: getBudgetSummary,
    staleTime: 60_000,
  })
  const account = data?.account
  if (!data?.enabled || !account) return null
  return (
    <section className="rounded-2xl border border-gold/25 bg-gradient-to-br from-gold/10 to-bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="rounded-xl bg-gold/15 p-3 text-gold"><PiggyBank size={24} /></div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-wider text-text-muted">Allowance wallet</p>
          <p className="text-2xl font-black text-gold">{money(account.balance_cents, account.currency)}</p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-right text-xs">
          <div><p className="flex items-center justify-end gap-1 text-text-muted"><CalendarDays size={12} /> Next</p><p className="font-semibold text-text-primary">{account.next_credit_date || 'Paused'}</p></div>
          <div><p className="flex items-center justify-end gap-1 text-text-muted"><Coins size={12} /> Affordable</p><p className="font-semibold text-text-primary">{account.affordable_count}</p></div>
        </div>
        <button type="button" className="btn-primary w-full sm:w-auto" onClick={() => navigate('/wallet')}>Open wallet</button>
      </div>
    </section>
  )
}
