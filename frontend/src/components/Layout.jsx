import { Outlet, useLocation } from 'react-router-dom'
import AppNav from './AppNav'
import { useQuery } from '@tanstack/react-query'
import { getBudgetSummary } from '../api/client'
import BudgetCart from './BudgetCart'

export default function Layout() {
  const location = useLocation()
  const isHome = location.pathname === '/'
  const showBudgetCart = /^\/(sets|search|collection|pokedex)(?:\/|$)/.test(location.pathname)
  const summary = useQuery({ queryKey: ['budget-summary', null], queryFn: () => getBudgetSummary() })

  return (
    <div className="min-h-dvh flex flex-col bg-bg overflow-x-hidden">
      {!isHome && <AppNav />}
      <main className={`flex-1 ${!isHome ? 'w-full px-6 pb-8 sm:px-8 lg:px-10 xl:px-12' : ''}`}>
        <Outlet />
      </main>
      {showBudgetCart && <BudgetCart summary={summary.data} />}
    </div>
  )
}
