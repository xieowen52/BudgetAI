import { type FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import api from '../api/client'
import { useConfirm } from '../components/ConfirmProvider'
import {
  CATEGORIES,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  type Category,
  type FundingStrategy,
  type Plan,
  type PlanAnalysis,
} from '../types'

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function fmt0(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export default function PlanPage() {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [analysis, setAnalysis] = useState<PlanAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [selectedMonth, setSelectedMonth] = useState(0)

  // What-if explorer
  const [wiCat, setWiCat] = useState<Category>('food')
  const [wiDelta, setWiDelta] = useState(0) // $/month change; negative = spend less

  // Add income-change form
  const [icAmount, setIcAmount] = useState('')
  const [icMonth, setIcMonth] = useState(0)
  const [icError, setIcError] = useState('')
  const [icSaving, setIcSaving] = useState(false)

  // Add-event form
  const [evName, setEvName] = useState('')
  const [evAmount, setEvAmount] = useState('')
  const [evCategory, setEvCategory] = useState<Category>('other')
  const [evMonth, setEvMonth] = useState(0)
  const [evFunding, setEvFunding] = useState<FundingStrategy>('spread')
  const [evError, setEvError] = useState('')
  const [evSaving, setEvSaving] = useState(false)

  function fetchAnalysis() {
    setAnalysisLoading(true)
    // Analysis can take a moment when AI insights are enabled, so it
    // loads after the plan renders instead of blocking it.
    api
      .get<PlanAnalysis>('/plans/analysis')
      .then((a) => setAnalysis(a.data))
      .finally(() => setAnalysisLoading(false))
  }

  useEffect(() => {
    api
      .get<Plan>('/plans/current')
      .then((res) => {
        setPlan(res.data)
        // Land on the current calendar month when it's inside the plan
        const start = new Date(res.data.start_date + 'T00:00:00')
        const now = new Date()
        const idx = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth())
        setSelectedMonth(Math.min(Math.max(idx, 0), res.data.horizon_months - 1))
        fetchAnalysis()
      })
      .catch(() => setPlan(null))
      .finally(() => setLoading(false))
  }, [])

  async function deletePlan() {
    if (!(await confirm({
      title: 'Delete this plan?',
      message: 'Your transactions are not affected.',
      confirmLabel: 'Delete', destructive: true,
    }))) return
    await api.delete('/plans/current')
    setPlan(null)
    setAnalysis(null)
  }

  async function addEvent(e: FormEvent) {
    e.preventDefault()
    setEvSaving(true)
    setEvError('')
    try {
      const res = await api.post<Plan>('/plans/events', {
        name: evName,
        category: evCategory,
        amount: parseFloat(evAmount),
        month_index: evMonth,
        funding: evFunding,
      })
      setPlan(res.data)
      setEvName('')
      setEvAmount('')
      fetchAnalysis()
    } catch (err: any) {
      setEvError(err.response?.data?.detail ?? 'Could not add the event')
    } finally {
      setEvSaving(false)
    }
  }

  async function addIncomeChange(e: FormEvent) {
    e.preventDefault()
    setIcSaving(true)
    setIcError('')
    try {
      const res = await api.post<Plan>('/plans/income-changes', {
        month_index: icMonth,
        monthly_amount: parseFloat(icAmount),
      })
      setPlan(res.data)
      setIcAmount('')
      fetchAnalysis()
    } catch (err: any) {
      setIcError(err.response?.data?.detail ?? 'Could not add the income change')
    } finally {
      setIcSaving(false)
    }
  }

  async function deleteIncomeChange(id: string) {
    if (!(await confirm({
      title: 'Remove this income change?',
      message: 'Affected months go back to the regular amount.',
      confirmLabel: 'Remove', destructive: true,
    }))) return
    try {
      await api.delete(`/plans/income-changes/${id}`)
      const res = await api.get<Plan>('/plans/current')
      setPlan(res.data)
      fetchAnalysis()
    } catch (err: any) {
      alert(err.response?.data?.detail ?? 'Could not remove the income change')
    }
  }

  async function deleteEvent(id: string, name: string) {
    if (!(await confirm({
      title: `Remove "${name}"?`,
      message: 'Affected months go back to the regular budget.',
      confirmLabel: 'Remove', destructive: true,
    }))) return
    await api.delete(`/plans/events/${id}`)
    const res = await api.get<Plan>('/plans/current')
    setPlan(res.data)
    fetchAnalysis()
  }

  if (loading) return <p className="text-slate-400 text-sm">Loading…</p>

  if (!plan) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-12 text-center space-y-3">
        <p className="text-4xl">🗺️</p>
        <h2 className="text-lg font-semibold text-slate-900">No budget plan yet</h2>
        <p className="text-sm text-slate-500 max-w-md mx-auto">
          Answer a few questions about your income, bills, and goals, and we'll
          generate a month-by-month budget that actually fits your life.
        </p>
        <Link
          to="/plan/new"
          className="inline-block px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors"
        >
          Create my plan
        </Link>
      </div>
    )
  }

  const start = new Date(plan.start_date + 'T00:00:00')
  const lastMonth = plan.months[plan.months.length - 1]
  const month = plan.months[selectedMonth]
  const monthHasEvents = plan.events.some((ev) => {
    return ev.funding === 'absorb' ? ev.month_index === selectedMonth : ev.month_index >= selectedMonth
  })
  const { summary } = plan
  const isPot = plan.funding_mode === 'pot'
  const horizon = plan.horizon_months
  const monthsAnalyzed = analysis?.months_analyzed ?? 0

  // Goal trajectory: planned line over the full horizon plus the actual
  // line for elapsed months. Income mode climbs toward the savings goal;
  // pot mode descends toward the leftover target.
  const potSpendPerMonth = isPot && plan.total_funds != null
    ? (plan.total_funds - plan.savings_goal) / horizon
    : 0
  let cumActual = 0
  const goalData = plan.months.map((m, i) => {
    const planned = isPot
      ? Math.round((plan.total_funds! - potSpendPerMonth * (i + 1)) * 100) / 100
      : Math.round(summary.monthly_savings * (i + 1) * 100) / 100
    let actual: number | null = null
    if (analysis && i < monthsAnalyzed) {
      if (isPot) {
        actual = analysis.months[i].remaining_funds
      } else {
        cumActual += analysis.months[i].savings_actual
        actual = Math.round(cumActual * 100) / 100
      }
    }
    return { label: `${MONTHS[m.month - 1]}`, planned, actual }
  })

  // What-if: shift one category's monthly spend and recompute the impact
  // against the elapsed months (pure arithmetic over the analysis data).
  const whatIf = (() => {
    if (!analysis || monthsAnalyzed === 0) return null
    let actualTotal = 0
    let plannedTotal = 0
    let found = false
    for (const m of analysis.months) {
      const c = m.categories.find((x) => x.category === wiCat)
      if (c) { actualTotal += c.actual; plannedTotal += c.planned; found = true }
    }
    if (!found) return null
    const newActualTotal = Math.max(0, actualTotal + wiDelta * monthsAnalyzed)
    return {
      n: monthsAnalyzed,
      saved: actualTotal - newActualTotal, // positive = saved more
      newMonthlyAvg: newActualTotal / monthsAnalyzed,
      plannedMonthly: plannedTotal / monthsAnalyzed,
    }
  })()
  const wiCategories = analysis?.months[0]?.categories.map((c) => c.category) ?? CATEGORIES

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Budget Plan</h2>
          <p className="text-sm text-slate-500">
            {MONTHS[start.getMonth()]} {start.getFullYear()} – {MONTHS[lastMonth.month - 1]}{' '}
            {lastMonth.year} · {plan.horizon_months} months
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={async () => {
              if (await confirm({
                title: 'Start a new plan?',
                message: 'This replaces your current plan once you finish the wizard. Your transactions are not affected.',
                confirmLabel: 'Start over',
              })) {
                navigate('/plan/new')
              }
            }}
            className="text-sm font-medium text-indigo-600 hover:text-indigo-700"
          >
            Start over
          </button>
          <button onClick={deletePlan} className="text-sm font-medium text-slate-400 hover:text-red-500 transition-colors">
            Delete
          </button>
        </div>
      </div>

      {/* The arithmetic: income − fixed − savings = spending money */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          [isPot ? 'Monthly draw' : 'Monthly income', summary.monthly_income, ''],
          ['Fixed costs', summary.fixed_total, '− '],
          [isPot ? 'Kept aside' : 'Savings', summary.monthly_savings, '− '],
          ['To spend', summary.discretionary, '= '],
        ].map(([label, value, prefix]) => (
          <div key={label as string} className="bg-white rounded-xl border border-slate-200 p-4">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="text-lg font-semibold text-slate-900">
              <span className="text-slate-400 font-normal">{prefix}</span>
              {fmt(value as number)}
            </p>
          </div>
        ))}
      </div>

      {isPot && plan.total_funds != null && (
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-5 py-3 text-sm text-indigo-700">
          🏦 Living off <span className="font-semibold">{fmt(plan.total_funds)}</span> —{' '}
          {fmt(summary.monthly_income)}/month for {plan.horizon_months} months
          {plan.savings_goal > 0 && (
            <>
              , ending with <span className="font-semibold">{fmt(plan.savings_goal)}</span> still in the bank
            </>
          )}
          .
        </div>
      )}
      {!isPot && plan.savings_goal > 0 && (
        <div className="bg-indigo-50 border border-indigo-100 rounded-xl px-5 py-3 text-sm text-indigo-700">
          🎯 Saving {fmt(summary.monthly_savings)}/month puts you at{' '}
          <span className="font-semibold">{fmt(plan.savings_goal)}</span> by{' '}
          {MONTHS[lastMonth.month - 1]} {lastMonth.year}.
        </div>
      )}

      {/* Goal trajectory: planned pace vs. actual */}
      {plan.savings_goal > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-semibold text-slate-700">
              {isPot ? 'Will the money last?' : 'Savings goal progress'}
            </p>
            <span className="text-xs text-slate-400">
              Target: {fmt(plan.savings_goal)}{isPot ? ' left' : ' saved'}
            </span>
          </div>
          <p className="text-xs text-slate-400 mb-4">
            {monthsAnalyzed > 0
              ? isPot
                ? 'Your actual balance against the planned spend-down pace.'
                : 'Your actual savings against the planned pace.'
              : 'The planned pace — your actual line appears after your first full month.'}
          </p>
          <ResponsiveContainer width="100%" height={240} debounce={1}>
            <LineChart data={goalData} margin={{ top: 5, right: 8, bottom: 0, left: 8 }}>
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(v) => fmt0(Number(v))} tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={56} />
              <Tooltip
                formatter={(v, name) => [fmt(Number(v)), name === 'planned' ? 'Planned' : 'Actual']}
                contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13 }}
              />
              <ReferenceLine y={plan.savings_goal} stroke="#22c55e" strokeDasharray="4 4"
                label={{ value: 'Goal', position: 'right', fontSize: 11, fill: '#22c55e' }} />
              <Line type="monotone" dataKey="planned" stroke="#94a3b8" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              {/* Hold the actual line until analysis resolves, so it doesn't
                  flash as disconnected dots while loading (C-1). */}
              {!analysisLoading && (
                <Line type="monotone" dataKey="actual" stroke="#6366f1" strokeWidth={2.5}
                  dot={{ r: 3, fill: '#6366f1' }} connectNulls={false} isAnimationActive={false} />
              )}
            </LineChart>
          </ResponsiveContainer>
          {monthsAnalyzed > 0 && (() => {
            const last = goalData[monthsAnalyzed - 1]
            if (last.actual == null) return null
            // Income: more saved than planned. Pot: higher balance = spent slower. Same test.
            const ahead = last.actual >= last.planned
            return (
              <p className={`text-xs mt-2 font-medium ${ahead ? 'text-green-600' : 'text-amber-600'}`}>
                {ahead
                  ? `✅ ${isPot ? 'Spending slower than planned' : 'Ahead of pace'} — ${fmt(last.actual)} vs. ${fmt(last.planned)} planned by ${last.label}.`
                  : `⚠️ ${isPot ? 'Burning faster than planned' : 'Behind pace'} — ${fmt(last.actual)} vs. ${fmt(last.planned)} planned by ${last.label}.`}
              </p>
            )
          })()}
        </div>
      )}

      {/* Per-month budget with month tabs (events make months differ) */}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-700">Monthly budget</p>
          <div className="flex gap-1">
            {plan.months.map((m) => (
              <button
                key={m.month_index}
                onClick={() => setSelectedMonth(m.month_index)}
                className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                  m.month_index === selectedMonth
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {MONTHS[m.month - 1]}
              </button>
            ))}
          </div>
        </div>
        <div className="divide-y divide-slate-100">
          {month.allocations.map((a) => (
            <div key={a.category} className="flex items-center justify-between px-6 py-3">
              <span className="text-sm text-slate-700">
                {CATEGORY_ICONS[a.category]} {CATEGORY_LABELS[a.category]}
                {a.is_fixed && (
                  <span className="ml-2 text-xs font-medium px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">
                    fixed
                  </span>
                )}
              </span>
              <span className="text-sm font-medium text-slate-900">{fmt(a.amount)}</span>
            </div>
          ))}
        </div>
        <div className="px-6 py-3 border-t border-slate-100 text-xs text-slate-500 space-x-2">
          {month.unallocated > 0 && (
            <span>💡 {fmt(month.unallocated)} unassigned buffer this month.</span>
          )}
          {monthHasEvents && (
            <span className="text-indigo-600">Adjusted for your planned events.</span>
          )}
        </div>
      </div>

      {/* Irregular events */}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-6 py-4 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-700">One-time events</p>
          <p className="text-xs text-slate-400 mt-0.5">
            A trip, a laptop, concert tickets — plan for it and the months adjust automatically.
          </p>
        </div>

        {plan.events.length > 0 && (
          <div className="divide-y divide-slate-100">
            {plan.events.map((ev) => {
              const evDate = plan.months[ev.month_index]
              return (
                <div key={ev.id} className="flex items-center justify-between px-6 py-3">
                  <div>
                    <span className="text-sm font-medium text-slate-800">
                      {CATEGORY_ICONS[ev.category]} {ev.name}
                    </span>
                    <p className="text-xs text-slate-400">
                      {MONTHS[evDate.month - 1]} {evDate.year} ·{' '}
                      {ev.funding === 'spread' ? 'saving up across earlier months' : 'absorbed that month'}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-medium text-slate-900">{fmt(ev.amount)}</span>
                    <button
                      onClick={() => deleteEvent(ev.id, ev.name)}
                      className="text-slate-300 hover:text-red-400 transition-colors text-lg leading-none"
                      title="Remove event"
                    >
                      ×
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <form onSubmit={addEvent} className="px-6 py-4 border-t border-slate-100 space-y-3">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">What is it?</label>
              <input
                type="text"
                required
                maxLength={60}
                value={evName}
                onChange={(e) => setEvName(e.target.value)}
                placeholder="e.g. Spring break trip"
                className="w-44 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Cost ($)</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                value={evAmount}
                onChange={(e) => setEvAmount(e.target.value)}
                placeholder="e.g. 400"
                className="w-28 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Category</label>
              <select
                value={evCategory}
                onChange={(e) => setEvCategory(e.target.value as Category)}
                className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">When</label>
              <select
                value={evMonth}
                onChange={(e) => setEvMonth(parseInt(e.target.value))}
                className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {plan.months.map((m) => (
                  <option key={m.month_index} value={m.month_index}>
                    {MONTHS[m.month - 1]} {m.year}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap gap-4 items-center">
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input
                type="radio"
                checked={evFunding === 'spread'}
                onChange={() => setEvFunding('spread')}
              />
              Save up for it
              <span className="text-xs text-slate-400">(split across the months before)</span>
            </label>
            <label className="flex items-center gap-1.5 text-sm text-slate-600">
              <input
                type="radio"
                checked={evFunding === 'absorb'}
                onChange={() => setEvFunding('absorb')}
              />
              Absorb it that month
            </label>
            <button
              type="submit"
              disabled={evSaving}
              className="ml-auto px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {evSaving ? 'Adding…' : 'Add event'}
            </button>
          </div>
          {evError && <p className="text-sm text-red-600">{evError}</p>}
        </form>
      </div>

      {/* Income changes */}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-6 py-4 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-700">
            {isPot ? 'Funding changes' : 'Income changes'}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            {isPot
              ? 'Got money coming in partway through? Set a new monthly amount from that month on.'
              : 'Starting a job, a raise, a drop in hours? Set your new monthly income from that month on.'}
          </p>
        </div>

        {plan.income_changes.length > 0 && (
          <div className="divide-y divide-slate-100">
            {plan.income_changes.map((ic) => {
              const d = plan.months[ic.month_index]
              return (
                <div key={ic.id} className="flex items-center justify-between px-6 py-3">
                  <div>
                    <span className="text-sm font-medium text-slate-800">
                      {fmt(ic.monthly_amount)}/mo
                    </span>
                    <p className="text-xs text-slate-400">
                      from {MONTHS[d.month - 1]} {d.year} onward
                    </p>
                  </div>
                  <button
                    onClick={() => deleteIncomeChange(ic.id)}
                    className="text-slate-300 hover:text-red-400 transition-colors text-lg leading-none"
                    title="Remove income change"
                  >
                    ×
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <form onSubmit={addIncomeChange} className="px-6 py-4 border-t border-slate-100 flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              New monthly {isPot ? 'amount' : 'income'} ($)
            </label>
            <input
              type="number" step="0.01" min="0.01" required
              value={icAmount}
              onChange={(e) => setIcAmount(e.target.value)}
              placeholder="e.g. 2500"
              className="w-32 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Starting</label>
            <select
              value={icMonth}
              onChange={(e) => setIcMonth(parseInt(e.target.value))}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {plan.months.map((m) => (
                <option key={m.month_index} value={m.month_index}>
                  {MONTHS[m.month - 1]} {m.year}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={icSaving}
            className="ml-auto px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {icSaving ? 'Adding…' : 'Add change'}
          </button>
          {icError && <p className="w-full text-sm text-red-600">{icError}</p>}
        </form>
      </div>

      {/* Analysis: plan vs. actuals */}
      <div className="bg-white rounded-xl border border-slate-200">
        <div className="px-6 py-4 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-700">How it's going</p>
        </div>
        <div className="px-6 py-4 space-y-4">
          {analysisLoading ? (
            <p className="text-sm text-slate-400">Analyzing your spending…</p>
          ) : !analysis || analysis.months_analyzed === 0 ? (
            <p className="text-sm text-slate-500">
              {analysis?.insights_note ?? 'Analysis will appear after your first full month on the plan.'}
            </p>
          ) : (
            <>
              {(analysis.consistently_over.length > 0 || analysis.consistently_under.length > 0) && (
                <div className="flex flex-wrap gap-2">
                  {analysis.consistently_over.map((c) => (
                    <span key={c} className="text-xs font-medium px-2 py-1 bg-red-50 text-red-600 rounded-full">
                      {CATEGORY_ICONS[c]} {CATEGORY_LABELS[c]} — consistently over
                    </span>
                  ))}
                  {analysis.consistently_under.map((c) => (
                    <span key={c} className="text-xs font-medium px-2 py-1 bg-green-50 text-green-700 rounded-full">
                      {CATEGORY_ICONS[c]} {CATEGORY_LABELS[c]} — on track
                    </span>
                  ))}
                </div>
              )}

              {/* Per-month plan vs actual */}
              <div className="space-y-3">
                {analysis.months.map((m) => (
                  <div key={m.month_index} className="border border-slate-100 rounded-lg">
                    <div className="flex items-center justify-between px-4 py-2 bg-slate-50 rounded-t-lg">
                      <span className="text-xs font-semibold text-slate-600">
                        {MONTHS[m.month - 1]} {m.year}
                      </span>
                      {m.remaining_funds != null && m.expected_remaining != null ? (
                        <span className={`text-xs font-medium ${m.remaining_funds >= m.expected_remaining ? 'text-green-600' : 'text-amber-600'}`}>
                          {fmt(m.remaining_funds)} left · plan says {fmt(m.expected_remaining)}
                        </span>
                      ) : (
                        <span className={`text-xs font-medium ${m.savings_actual >= m.savings_planned ? 'text-green-600' : 'text-amber-600'}`}>
                          saved {fmt(m.savings_actual)} of {fmt(m.savings_planned)} planned
                        </span>
                      )}
                    </div>
                    <div className="divide-y divide-slate-50">
                      {m.categories.map((c) => (
                        <div key={c.category} className="flex items-center justify-between px-4 py-1.5">
                          <span className="text-xs text-slate-600">
                            {CATEGORY_ICONS[c.category]} {CATEGORY_LABELS[c.category]}
                          </span>
                          <span className={`text-xs font-medium ${c.difference < 0 ? 'text-red-600' : 'text-slate-700'}`}>
                            {fmt(c.actual)} / {fmt(c.planned)}
                            {c.difference < 0 && ` (${fmt(-c.difference)} over)`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* AI insights */}
              {analysis.insights ? (
                <div className="space-y-3 pt-1">
                  {analysis.insights.going_well.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-green-700 mb-1">✅ Going well</p>
                      {analysis.insights.going_well.map((s, i) => (
                        <p key={i} className="text-sm text-slate-600">{s}</p>
                      ))}
                    </div>
                  )}
                  {analysis.insights.needs_attention.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-amber-700 mb-1">⚠️ Needs attention</p>
                      {analysis.insights.needs_attention.map((s, i) => (
                        <p key={i} className="text-sm text-slate-600">{s}</p>
                      ))}
                    </div>
                  )}
                  {analysis.insights.suggestions.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-indigo-700 mb-1">💡 Suggestions</p>
                      {analysis.insights.suggestions.map((s, i) => (
                        <p key={i} className="text-sm text-slate-600">{s}</p>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                analysis.insights_note && (
                  <p className="text-xs text-slate-400">{analysis.insights_note}</p>
                )
              )}
            </>
          )}
        </div>
      </div>

      {/* What-if explorer */}
      {whatIf && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <p className="text-sm font-semibold text-slate-700">What if…</p>
          <p className="text-xs text-slate-400 mt-0.5 mb-4">
            See how a change in one category would have played out over your {whatIf.n} tracked month{whatIf.n === 1 ? '' : 's'}.
          </p>

          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-700 mb-4">
            <span>I spent</span>
            <span className={`font-semibold ${wiDelta < 0 ? 'text-green-600' : wiDelta > 0 ? 'text-red-500' : 'text-slate-400'}`}>
              {wiDelta === 0 ? 'the same' : `${fmt0(Math.abs(wiDelta))} ${wiDelta < 0 ? 'less' : 'more'}`}
            </span>
            <span>per month on</span>
            <select
              value={wiCat}
              onChange={(e) => setWiCat(e.target.value as Category)}
              className="px-2 py-1 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {wiCategories.map((c) => (
                <option key={c} value={c}>{CATEGORY_ICONS[c]} {CATEGORY_LABELS[c]}</option>
              ))}
            </select>
          </div>

          <input
            type="range" min={-200} max={200} step={10}
            value={wiDelta}
            onChange={(e) => setWiDelta(parseInt(e.target.value))}
            className="w-full accent-indigo-600"
          />
          <div className="flex justify-between text-xs text-slate-400 mt-1">
            <span>−$200/mo</span>
            <button onClick={() => setWiDelta(0)} className="hover:text-slate-600 underline">reset</button>
            <span>+$200/mo</span>
          </div>

          {wiDelta !== 0 && (
            <div className="mt-4 bg-slate-50 rounded-lg px-4 py-3 space-y-1">
              <p className="text-sm text-slate-700">
                You'd have{' '}
                <span className={`font-semibold ${whatIf.saved >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                  {whatIf.saved >= 0 ? `saved ${fmt(whatIf.saved)} more` : `spent ${fmt(-whatIf.saved)} more`}
                </span>{' '}
                over those {whatIf.n} month{whatIf.n === 1 ? '' : 's'}.
              </p>
              <p className="text-xs text-slate-500">
                {CATEGORY_LABELS[wiCat]} would have averaged {fmt(whatIf.newMonthlyAvg)}/mo
                {(() => {
                  const diff = whatIf.plannedMonthly - whatIf.newMonthlyAvg
                  if (Math.abs(diff) < 0.5) return ' — right on budget.'
                  return diff > 0
                    ? ` — ${fmt(diff)} under your ${fmt(whatIf.plannedMonthly)} budget.`
                    : ` — still ${fmt(-diff)} over your ${fmt(whatIf.plannedMonthly)} budget.`
                })()}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
