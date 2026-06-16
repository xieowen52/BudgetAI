import { type FormEvent, useEffect, useState } from 'react'
import api from '../api/client'
import { type Budget, type BudgetProgress, CATEGORIES, CATEGORY_LABELS, type Category } from '../types'

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default function BudgetsPage() {
  const [progress, setProgress] = useState<BudgetProgress[]>([])
  const [budgets, setBudgets] = useState<Budget[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState<Category>('food')
  const [limit, setLimit] = useState('')
  const [saving, setSaving] = useState(false)

  function fetchData() {
    Promise.all([
      api.get<BudgetProgress[]>('/budgets/progress'),
      api.get<Budget[]>('/budgets/'),
    ]).then(([prog, buds]) => {
      setProgress(prog.data)
      setBudgets(buds.data)
      setLoading(false)
    })
  }

  useEffect(() => { fetchData() }, [])

  // Pre-fill the amount with the selected category's current limit (B-2),
  // so editing shows the existing value instead of a blank field. Keyed on
  // category + budgets, so typing (which changes neither) is never clobbered.
  useEffect(() => {
    const existing = budgets.find((b) => b.category === category)
    setLimit(existing ? String(existing.monthly_limit) : '')
  }, [category, budgets])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.put(`/budgets/${category}`, {
        category,
        monthly_limit: parseFloat(limit),
      })
      setLimit('')
      fetchData()
    } finally {
      setSaving(false)
    }
  }

  async function deleteBudget(cat: Category) {
    if (!confirm(`Remove budget limit for ${CATEGORY_LABELS[cat]}?`)) return
    await api.delete(`/budgets/${cat}`)
    fetchData()
  }

  const coveredCategories = new Set(budgets.map((b) => b.category))
  // Stable alphabetical order so the list doesn't jump after each save (B-3)
  const sortedProgress = [...progress].sort((a, b) =>
    CATEGORY_LABELS[a.category].localeCompare(CATEGORY_LABELS[b.category])
  )

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Budget Limits</h2>
        <p className="text-sm text-slate-500">Set monthly spending limits per category</p>
      </div>

      {/* Set / update a limit */}
      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <p className="text-sm font-semibold text-slate-700 mb-4">
          {coveredCategories.has(category) ? 'Update a budget limit' : 'Set a budget limit'}
        </p>
        <form onSubmit={handleSubmit} className="flex gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Monthly limit ($)</label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              required
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="e.g. 300"
              className="w-36 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Set limit'}
          </button>
        </form>
      </div>

      {/* Progress bars */}
      {loading ? (
        <p className="text-slate-400 text-sm">Loading…</p>
      ) : progress.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-400 text-sm">
          No budget limits set yet. Add one above.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {sortedProgress.map((item) => {
            const pct = Math.min(item.percentage, 100)
            return (
              <div key={item.category} className="px-6 py-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">
                      {CATEGORY_LABELS[item.category]}
                    </span>
                    {item.over_limit && (
                      <span className="text-xs font-medium px-1.5 py-0.5 bg-red-100 text-red-600 rounded">
                        Over limit
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-slate-500">
                      {fmt(item.spent)} / {fmt(item.monthly_limit)}
                    </span>
                    <button
                      onClick={() => deleteBudget(item.category)}
                      className="text-slate-300 hover:text-red-400 transition-colors text-lg leading-none"
                      title="Remove limit"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${item.over_limit ? 'bg-red-500' : pct > 75 ? 'bg-amber-400' : 'bg-indigo-500'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-xs text-slate-400 mt-1">{item.percentage.toFixed(0)}% used</p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
