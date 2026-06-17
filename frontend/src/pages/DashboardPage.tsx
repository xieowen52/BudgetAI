import { type FormEvent, useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from 'recharts'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  type Transaction, type PlanStatus, CATEGORY_COLORS, CATEGORY_LABELS, CATEGORY_ICONS,
  type Category, CATEGORIES,
} from '../types'

type ChartType = 'bar' | 'pie' | 'donut'

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

interface QuickAddModalProps {
  defaultType: 'expense' | 'income'
  onClose: () => void
  onSaved: () => void
}

function QuickAddModal({ defaultType, onClose, onSaved }: QuickAddModalProps) {
  const [form, setForm] = useState({
    amount: '',
    category: 'food',
    description: '',
    date: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })(),
    transaction_type: defaultType,
  })
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.post('/transactions/', { ...form, amount: parseFloat(form.amount) })
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-semibold text-slate-900">
            Quick add {defaultType}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Amount ($)</label>
              <input
                type="number" step="0.01" min="0.01" required
                value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="0.00" autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Date</label>
              <input
                type="date" required
                value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {form.transaction_type === 'expense' && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Category</label>
                <select
                  value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{CATEGORY_ICONS[c]} {CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
              </div>
            )}
            <div className={form.transaction_type === 'income' ? 'col-span-2' : ''}>
              <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
              <select
                value={form.transaction_type}
                onChange={(e) => {
                  const t = e.target.value as 'income' | 'expense'
                  setForm({ ...form, transaction_type: t, category: t === 'income' ? 'other' : form.category })
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Description <span className="text-slate-400 font-normal">(optional)</span></label>
            <input
              type="text"
              value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="e.g. Grocery run"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="submit" disabled={saving}
              className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button" onClick={onClose}
              className="flex-1 border border-slate-300 text-slate-700 py-2 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const navigate = useNavigate()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [chartType, setChartType] = useState<ChartType>('bar')
  const [quickAdd, setQuickAdd] = useState<'expense' | 'income' | null>(null)

  const [planStatus, setPlanStatus] = useState<PlanStatus | null>(null)
  const [demoBusy, setDemoBusy] = useState(false)

  function refetchAll() {
    fetchMonthly()
    api.get<Transaction[]>('/transactions/').then((r) => setAllTransactions(r.data))
    fetchPlanStatus()
  }

  async function loadDemo() {
    if (allTransactions.length > 0 &&
        !confirm('This replaces your current data with a sample financial history. Continue?')) return
    setDemoBusy(true)
    try {
      await api.post('/demo/seed')
      refetchAll()
    } finally {
      setDemoBusy(false)
    }
  }

  async function clearAll() {
    if (!confirm('Delete all your transactions, plan, and recurring items? This cannot be undone.')) return
    setDemoBusy(true)
    try {
      await api.delete('/demo/clear')
      refetchAll()
    } finally {
      setDemoBusy(false)
    }
  }

  function fetchMonthly() {
    setLoading(true)
    api.get<Transaction[]>('/transactions/', { params: { year, month } })
      .then((r) => setTransactions(r.data))
      .finally(() => setLoading(false))
  }

  function fetchPlanStatus() {
    api.get<PlanStatus>('/plans/status')
      .then((r) => setPlanStatus(r.data))
      .catch(() => setPlanStatus(null)) // 404 = no plan; card just hides
  }

  useEffect(() => { fetchMonthly() }, [year, month])

  useEffect(() => {
    // Catch up due recurring transactions first so this month's rent /
    // subscriptions are included in everything below
    api.post('/recurring/post-due')
      .catch(() => {})
      .finally(() => {
        fetchMonthly()
        api.get<Transaction[]>('/transactions/').then((r) => setAllTransactions(r.data))
        fetchPlanStatus()
      })
  }, [])

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear((y) => y - 1) }
    else setMonth((m) => m - 1)
  }
  function nextMonth() {
    if (month === 12) { setMonth(1); setYear((y) => y + 1) }
    else setMonth((m) => m + 1)
  }

  const summary = transactions.reduce(
    (acc, tx) => {
      if (tx.transaction_type === 'income') acc.income += tx.amount
      else acc.expenses += tx.amount
      return acc
    },
    { income: 0, expenses: 0 }
  )
  const net = summary.income - summary.expenses
  // Cap the displayed rate — a single large expense can drive it to absurd
  // values (e.g. -370365%) that are technically correct but useless (D-1).
  const savingsRateNum = summary.income > 0 ? (net / summary.income) * 100 : null
  const savingsRate =
    savingsRateNum === null ? null
    : savingsRateNum < -999 ? '< −999'
    : savingsRateNum > 999 ? '> 999'
    : savingsRateNum.toFixed(0)

  const byCategory = Object.values(
    transactions
      .filter((t) => t.transaction_type === 'expense')
      .reduce<Record<string, { category: Category; total: number }>>((acc, tx) => {
        if (!acc[tx.category]) acc[tx.category] = { category: tx.category, total: 0 }
        acc[tx.category].total += tx.amount
        return acc
      }, {})
  ).sort((a, b) => b.total - a.total)

  const yearlyData = useMemo(() => {
    const months = Array.from({ length: 12 }, (_, i) => ({
      name: new Date(year, i).toLocaleString('default', { month: 'short' }),
      income: 0,
      expenses: 0,
    }))
    allTransactions
      .filter((t) => new Date(t.date).getFullYear() === year)
      .forEach((t) => {
        const m = new Date(t.date).getMonth()
        if (t.transaction_type === 'income') months[m].income += t.amount
        else months[m].expenses += t.amount
      })
    return months
  }, [allTransactions, year])

  const monthLabel = new Date(year, month - 1).toLocaleString('default', {
    month: 'long', year: 'numeric',
  })
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1

  return (
    <div className="space-y-6">
      {/* Header with month navigation */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Dashboard</h2>
          <p className="text-sm text-slate-500">Your financial overview</p>
        </div>
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl px-2 py-1 shadow-sm">
          <button onClick={prevMonth} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors text-slate-600">
            ‹
          </button>
          <span className="text-sm font-medium text-slate-700 px-2 min-w-[130px] text-center">
            {monthLabel}
          </span>
          <button
            onClick={nextMonth}
            disabled={isCurrentMonth}
            className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors text-slate-600 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            ›
          </button>
        </div>
      </div>

      {/* First-run demo prompt — only when there's no data yet */}
      {!loading && allTransactions.length === 0 && (
        <div className="bg-gradient-to-r from-indigo-50 to-violet-50 border border-indigo-100 rounded-xl p-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-800">👋 New here? Load a sample history.</p>
            <p className="text-sm text-slate-500 mt-0.5">
              A few months of demo transactions and a budget plan, so you can see analysis,
              budgets, and burn-rate in action right away.
            </p>
          </div>
          <button
            onClick={loadDemo}
            disabled={demoBusy}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors flex-shrink-0"
          >
            {demoBusy ? 'Loading…' : 'Load demo data'}
          </button>
        </div>
      )}

      {/* Summary cards + quick-add */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-green-400 rounded-t-xl" />
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Income</p>
          <p className="text-2xl font-bold text-green-600 mt-1">{fmt(summary.income)}</p>
          <button
            onClick={() => setQuickAdd('income')}
            className="mt-3 text-xs text-green-600 hover:text-green-700 font-medium flex items-center gap-1"
          >
            + Add income
          </button>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-red-400 rounded-t-xl" />
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Expenses</p>
          <p className="text-2xl font-bold text-red-500 mt-1">{fmt(summary.expenses)}</p>
          <button
            onClick={() => setQuickAdd('expense')}
            className="mt-3 text-xs text-red-500 hover:text-red-600 font-medium flex items-center gap-1"
          >
            + Add expense
          </button>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm relative overflow-hidden">
          <div className={`absolute top-0 left-0 right-0 h-1 rounded-t-xl ${net >= 0 ? 'bg-indigo-400' : 'bg-orange-400'}`} />
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Net</p>
          <p className={`text-2xl font-bold mt-1 ${net >= 0 ? 'text-indigo-600' : 'text-orange-500'}`}>
            {fmt(net)}
          </p>
          <p className="mt-3 text-xs text-slate-400">
            {net >= 0 ? 'Surplus' : 'Deficit'}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-violet-400 rounded-t-xl" />
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Savings rate</p>
          <p className="text-2xl font-bold text-violet-600 mt-1">
            {savingsRate !== null ? `${savingsRate}%` : '—'}
          </p>
          <button
            onClick={() => navigate('/transactions')}
            className="mt-3 text-xs text-slate-400 hover:text-slate-600 font-medium"
          >
            View all →
          </button>
        </div>
      </div>

      {/* Plan check — how this month tracks against the budget plan */}
      {isCurrentMonth && planStatus?.active && (() => {
        const flexible = planStatus.categories.filter((c) => !c.is_fixed)
        const over = flexible.filter((c) => c.remaining < 0)
        const headline =
          over.length > 0
            ? `⚠️ ${over.map((c) => `${CATEGORY_LABELS[c.category]} ${fmt(-c.remaining)} over`).join(' · ')}`
            : `✅ On budget so far`
        return (
          <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-700">Plan check</h3>
                <p className={`text-xs mt-0.5 ${over.length > 0 ? 'text-red-600 font-medium' : 'text-green-600'}`}>
                  {headline} — {planStatus.days_left} day{planStatus.days_left === 1 ? '' : 's'} left this month
                </p>
              </div>
              <button onClick={() => navigate('/plan')} className="text-xs text-indigo-600 hover:underline flex-shrink-0">
                View plan →
              </button>
            </div>
            <div className="space-y-2">
              {flexible.map((c) => {
                const pct = c.planned > 0 ? Math.min((c.spent / c.planned) * 100, 100) : 0
                return (
                  <div key={c.category} className="flex items-center gap-3">
                    <span className="text-base w-5 flex-shrink-0">{CATEGORY_ICONS[c.category]}</span>
                    <span className="text-xs text-slate-600 w-24 flex-shrink-0">{CATEGORY_LABELS[c.category]}</span>
                    <div className="flex-1 bg-slate-100 rounded-full h-1.5 min-w-0">
                      <div
                        className={`h-1.5 rounded-full transition-all ${c.remaining < 0 ? 'bg-red-500' : pct > 75 ? 'bg-amber-400' : 'bg-indigo-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className={`text-xs w-28 text-right flex-shrink-0 ${c.remaining < 0 ? 'text-red-600 font-semibold' : 'text-slate-500'}`}>
                      {c.remaining < 0 ? `${fmt(-c.remaining)} over` : `${fmt(c.remaining)} left`}
                    </span>
                  </div>
                )
              })}
            </div>
            {planStatus.buffer > 0 && (
              <p className="text-xs text-slate-400 mt-3">
                💡 Plus a {fmt(planStatus.buffer)} unassigned buffer this month.
              </p>
            )}
          </div>
        )
      })()}

      {/* Spending chart */}
      {byCategory.length > 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-sm font-semibold text-slate-700">Spending by category</h3>
            <div className="flex gap-1 bg-slate-100 rounded-lg p-1">
              {(['bar', 'pie', 'donut'] as ChartType[]).map((type) => (
                <button
                  key={type}
                  onClick={() => setChartType(type)}
                  className={`px-3 py-1 text-xs font-medium rounded-md capitalize transition-colors ${
                    chartType === type
                      ? 'bg-white text-slate-800 shadow-sm'
                      : 'text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="h-48 flex items-center justify-center text-slate-400 text-sm">Loading…</div>
          ) : chartType === 'bar' ? (
            <ResponsiveContainer width="100%" height={220} debounce={1}>
              <BarChart data={byCategory} barSize={32}>
                <XAxis
                  dataKey="category"
                  tickFormatter={(v) => `${CATEGORY_ICONS[v as Category]} ${CATEGORY_LABELS[v as Category]}`}
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false} tickLine={false}
                />
                <YAxis
                  tickFormatter={(v) => `$${v}`}
                  tick={{ fontSize: 11, fill: '#64748b' }}
                  axisLine={false} tickLine={false}
                />
                <Tooltip
                  formatter={(v) => [fmt(Number(v)), 'Spent']}
                  labelFormatter={(l) => `${CATEGORY_ICONS[l as Category]} ${CATEGORY_LABELS[l as Category]}`}
                  contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }}
                />
                <Bar dataKey="total" radius={[6, 6, 0, 0]}>
                  {byCategory.map((entry) => (
                    <Cell key={entry.category} fill={CATEGORY_COLORS[entry.category]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <ResponsiveContainer width="100%" height={240} debounce={1}>
              <PieChart>
                <Pie
                  data={byCategory}
                  dataKey="total"
                  nameKey="category"
                  cx="50%"
                  cy="50%"
                  outerRadius={90}
                  innerRadius={chartType === 'donut' ? 48 : 0}
                  paddingAngle={chartType === 'donut' ? 3 : 0}
                >
                  {byCategory.map((entry) => (
                    <Cell key={entry.category} fill={CATEGORY_COLORS[entry.category]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v) => [fmt(Number(v)), 'Spent']}
                  labelFormatter={(l) => `${CATEGORY_ICONS[l as Category]} ${CATEGORY_LABELS[l as Category]}`}
                  contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}

          {/* Breakdown list — readable regardless of chart proportions */}
          {!loading && byCategory.length > 0 && (() => {
            const total = byCategory.reduce((s, c) => s + c.total, 0)
            const max = byCategory[0].total
            return (
              <div className="mt-4 border-t border-slate-100 pt-4 space-y-2">
                {byCategory.map((item) => (
                  <div key={item.category} className="flex items-center gap-3">
                    <span className="text-base w-5 flex-shrink-0">{CATEGORY_ICONS[item.category]}</span>
                    <span className="text-xs text-slate-600 w-24 flex-shrink-0">{CATEGORY_LABELS[item.category]}</span>
                    <div className="flex-1 bg-slate-100 rounded-full h-1.5 min-w-0">
                      <div
                        className="h-1.5 rounded-full transition-all"
                        style={{
                          width: `${(item.total / max) * 100}%`,
                          background: CATEGORY_COLORS[item.category],
                        }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-slate-700 w-16 text-right flex-shrink-0">
                      {fmt(item.total)}
                    </span>
                    <span className="text-xs text-slate-400 w-8 text-right flex-shrink-0">
                      {Math.round((item.total / total) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      ) : !loading && (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center shadow-sm">
          <p className="text-3xl mb-2">📊</p>
          <p className="text-slate-500 text-sm">No expenses this month yet.</p>
          <button
            onClick={() => setQuickAdd('expense')}
            className="mt-3 text-sm text-indigo-600 hover:underline font-medium"
          >
            Add your first expense
          </button>
        </div>
      )}

      {/* Recent transactions */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-700">Recent transactions</h3>
          <button onClick={() => navigate('/transactions')} className="text-xs text-indigo-600 hover:underline">
            View all
          </button>
        </div>
        {loading ? (
          <p className="px-6 py-8 text-center text-slate-400 text-sm">Loading…</p>
        ) : transactions.length === 0 ? (
          <p className="px-6 py-8 text-center text-slate-400 text-sm">No transactions this month.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {transactions.slice(0, 6).map((tx) => (
              <li key={tx.id} className="px-6 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-base flex-shrink-0"
                    style={{ background: `${CATEGORY_COLORS[tx.category]}18` }}
                  >
                    {CATEGORY_ICONS[tx.category]}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-slate-800">{tx.description || <span className="text-slate-400 italic">No description</span>}</p>
                    <p className="text-xs text-slate-400">{CATEGORY_LABELS[tx.category]} · {tx.date}</p>
                  </div>
                </div>
                <span className={`text-sm font-semibold ${tx.transaction_type === 'income' ? 'text-green-600' : 'text-slate-800'}`}>
                  {tx.transaction_type === 'income' ? '+' : '-'}{fmt(tx.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Yearly overview */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">{year} — yearly overview</h3>
            <p className="text-xs text-slate-400 mt-0.5">Income vs expenses by month</p>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setYear((y) => y - 1)} className="px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded-lg">
              ‹ {year - 1}
            </button>
            {year < now.getFullYear() && (
              <button onClick={() => setYear((y) => y + 1)} className="px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 rounded-lg">
                {year + 1} ›
              </button>
            )}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={200} debounce={1}>
          <BarChart data={yearlyData} barGap={2} barSize={18}>
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => `$${v}`} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <Tooltip
              formatter={(v, name) => [fmt(Number(v)), name === 'income' ? 'Income' : 'Expenses']}
              contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }}
            />
            <Legend
              formatter={(v) => v === 'income' ? 'Income' : 'Expenses'}
              iconType="circle" iconSize={8}
              wrapperStyle={{ fontSize: 12 }}
            />
            <Bar dataKey="income" fill="#22c55e" radius={[4, 4, 0, 0]} />
            <Bar dataKey="expenses" fill="#f87171" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Demo data controls — reset or wipe, available once there's data */}
      {allTransactions.length > 0 && (
        <div className="text-center text-xs text-slate-400 pt-2">
          Demo data:{' '}
          <button onClick={loadDemo} disabled={demoBusy} className="hover:text-indigo-500 underline disabled:opacity-50">
            reset to sample history
          </button>
          {' · '}
          <button onClick={clearAll} disabled={demoBusy} className="hover:text-red-500 underline disabled:opacity-50">
            clear everything
          </button>
        </div>
      )}

      {/* Quick-add modal */}
      {quickAdd && (
        <QuickAddModal
          defaultType={quickAdd}
          onClose={() => setQuickAdd(null)}
          onSaved={() => {
            fetchMonthly()
            api.get<Transaction[]>('/transactions/').then((r) => setAllTransactions(r.data))
          }}
        />
      )}
    </div>
  )
}
