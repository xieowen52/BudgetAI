import { type FormEvent, useEffect, useState } from 'react'
import api from '../api/client'
import {
  type Transaction, type ParsedTransaction, type RecurringTransaction,
  CATEGORIES, CATEGORY_LABELS, CATEGORY_ICONS,
} from '../types'
import { useConfirm } from '../components/ConfirmProvider'

function ordinal(n: number) {
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'
  return `${n}${suffix}`
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

type TxType = 'income' | 'expense'

interface TxForm {
  amount: string
  category: string
  description: string
  date: string
  transaction_type: TxType
}

function emptyForm(type: TxType = 'expense'): TxForm {
  return {
    amount: '',
    category: 'food',
    description: '',
    date: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` })(),
    transaction_type: type,
  }
}

function TxFormFields({
  form,
  onChange,
  onSubmit,
  onCancel,
  saving,
  submitLabel,
}: {
  form: TxForm
  onChange: (f: TxForm) => void
  onSubmit: (e: FormEvent) => void
  onCancel: () => void
  saving: boolean
  submitLabel: string
}) {
  const isIncome = form.transaction_type === 'income'
  return (
    <form onSubmit={onSubmit} className="grid grid-cols-2 gap-4">
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Amount ($)</label>
        <input
          type="number" step="0.01" min="0.01" required
          value={form.amount}
          onChange={(e) => onChange({ ...form, amount: e.target.value })}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Date</label>
        <input
          type="date" required
          value={form.date}
          onChange={(e) => onChange({ ...form, date: e.target.value })}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
        <select
          value={form.transaction_type}
          onChange={(e) => {
            const t = e.target.value as TxType
            onChange({ ...form, transaction_type: t, category: t === 'income' ? 'other' : form.category })
          }}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
      </div>
      {!isIncome && (
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Category</label>
          <select
            value={form.category}
            onChange={(e) => onChange({ ...form, category: e.target.value })}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{CATEGORY_ICONS[c]} {CATEGORY_LABELS[c]}</option>
            ))}
          </select>
        </div>
      )}
      <div className={isIncome ? 'col-span-2' : 'col-span-2'}>
        <label className="block text-xs font-medium text-slate-600 mb-1">Description <span className="text-slate-400 font-normal">(optional)</span></label>
        <input
          type="text"
          value={form.description}
          onChange={(e) => onChange({ ...form, description: e.target.value })}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          placeholder={isIncome ? 'e.g. Monthly paycheck' : 'e.g. Grocery run'}
        />
      </div>
      <div className="col-span-2 flex gap-2">
        <button
          type="submit" disabled={saving}
          className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button
          type="button" onClick={onCancel}
          className="px-4 py-2 border border-slate-300 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

export default function TransactionsPage() {
  const confirm = useConfirm()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  // NL parse state
  const [nlText, setNlText] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parsed, setParsed] = useState<ParsedTransaction | null>(null)
  const [parseError, setParseError] = useState('')

  // Add form
  const [showManual, setShowManual] = useState(false)
  const [addForm, setAddForm] = useState<TxForm>(emptyForm())
  const [saving, setSaving] = useState(false)

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<TxForm>(emptyForm())
  const [editSaving, setEditSaving] = useState(false)

  // Recurring templates
  const [recurring, setRecurring] = useState<RecurringTransaction[]>([])
  const [recurringLoaded, setRecurringLoaded] = useState(false)
  const [showRecurringForm, setShowRecurringForm] = useState(false)
  const [recForm, setRecForm] = useState({
    amount: '', category: 'housing', description: '', transaction_type: 'expense' as TxType, day_of_month: 1,
  })
  const [recSaving, setRecSaving] = useState(false)
  const [postedNote, setPostedNote] = useState('')

  function fetchTransactions() {
    api.get<Transaction[]>('/transactions/').then((r) => {
      setTransactions(r.data)
      setLoading(false)
    })
  }

  function fetchRecurring() {
    api.get<RecurringTransaction[]>('/recurring/')
      .then((r) => setRecurring(r.data))
      .finally(() => setRecurringLoaded(true))
  }

  useEffect(() => {
    // Catch up any due recurring transactions before loading the list,
    // so rent/subscriptions that came due since the last visit appear
    api.post<{ posted: Transaction[] }>('/recurring/post-due')
      .then((r) => {
        if (r.data.posted.length > 0) {
          setPostedNote(`🔄 Posted ${r.data.posted.length} recurring transaction${r.data.posted.length > 1 ? 's' : ''} that came due.`)
        }
      })
      .catch(() => {})
      .finally(() => {
        fetchTransactions()
        fetchRecurring()
      })
  }, [])

  async function addRecurring(e: FormEvent) {
    e.preventDefault()
    setRecSaving(true)
    try {
      await api.post('/recurring/', {
        ...recForm,
        amount: parseFloat(recForm.amount),
        category: recForm.transaction_type === 'income' ? 'other' : recForm.category,
      })
      setRecForm({ amount: '', category: 'housing', description: '', transaction_type: 'expense', day_of_month: 1 })
      setShowRecurringForm(false)
      // The first occurrence may be due immediately
      await api.post('/recurring/post-due').catch(() => {})
      fetchRecurring()
      fetchTransactions()
    } finally {
      setRecSaving(false)
    }
  }

  async function deleteRecurring(r: RecurringTransaction) {
    if (!(await confirm({
      title: `Stop the recurring "${r.description || CATEGORY_LABELS[r.category]}"?`,
      message: 'Already-posted transactions are kept.',
      confirmLabel: 'Stop', destructive: true,
    }))) return
    await api.delete(`/recurring/${r.id}`)
    fetchRecurring()
  }

  async function handleParse(e: FormEvent) {
    e.preventDefault()
    if (!nlText.trim()) return
    setParsing(true)
    setParseError('')
    setParsed(null)
    try {
      const { data } = await api.post<ParsedTransaction>('/parse/', { text: nlText })
      setParsed(data)
      setAddForm({
        amount: String(data.amount),
        category: data.category,
        description: data.description,
        date: data.date,
        transaction_type: data.transaction_type,
      })
    } catch {
      setParseError('Failed to parse. Try rephrasing.')
    } finally {
      setParsing(false)
    }
  }

  async function confirmParsed() {
    if (!parsed) return
    setSaving(true)
    try {
      await api.post('/transactions/', {
        amount: parsed.amount,
        category: parsed.category,
        description: parsed.description,
        date: parsed.date,
        transaction_type: parsed.transaction_type,
      })
      setParsed(null)
      setNlText('')
      setAddForm(emptyForm())
      fetchTransactions()
    } finally {
      setSaving(false)
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      await api.post('/transactions/', {
        ...addForm,
        amount: parseFloat(addForm.amount),
        category: addForm.transaction_type === 'income' ? 'other' : addForm.category,
      })
      setShowManual(false)
      setAddForm(emptyForm())
      fetchTransactions()
    } finally {
      setSaving(false)
    }
  }

  function startEdit(tx: Transaction) {
    setEditingId(tx.id)
    setEditForm({
      amount: String(tx.amount),
      category: tx.category,
      description: tx.description,
      date: tx.date,
      transaction_type: tx.transaction_type,
    })
  }

  async function handleEdit(e: FormEvent) {
    e.preventDefault()
    if (!editingId) return
    setEditSaving(true)
    try {
      await api.patch(`/transactions/${editingId}`, {
        amount: parseFloat(editForm.amount),
        category: editForm.transaction_type === 'income' ? 'other' : editForm.category,
        description: editForm.description,
        date: editForm.date,
        transaction_type: editForm.transaction_type,
      })
      setEditingId(null)
      fetchTransactions()
    } finally {
      setEditSaving(false)
    }
  }

  async function deleteTransaction(id: string) {
    if (!(await confirm({ title: 'Delete this transaction?', confirmLabel: 'Delete', destructive: true }))) return
    await api.delete(`/transactions/${id}`)
    setTransactions((prev) => prev.filter((t) => t.id !== id))
  }

  const filtered = transactions.filter((tx) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      tx.description.toLowerCase().includes(q) ||
      tx.category.toLowerCase().includes(q) ||
      tx.date.includes(q)
    )
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Transactions</h2>
          <p className="text-sm text-slate-500">Add and manage your transactions</p>
        </div>
        <button
          onClick={() => { setShowManual((v) => { if (!v) setAddForm(emptyForm()); return !v }); setParsed(null) }}
          className="px-4 py-2 text-sm font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 shadow-sm transition-colors"
        >
          {showManual ? 'Cancel' : '+ Add manually'}
        </button>
      </div>

      {/* Natural language input */}
      <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
        <p className="text-sm font-medium text-slate-700 mb-1">Describe a transaction in plain English</p>
        <p className="text-xs text-slate-400 mb-3">Powered by Claude AI</p>
        <form onSubmit={handleParse} className="flex gap-2">
          <input
            type="text"
            value={nlText}
            onChange={(e) => setNlText(e.target.value)}
            placeholder='e.g. "grabbed sushi for $32 last night" or "paid $14.99 for Spotify"'
            className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={parsing || !nlText.trim()}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {parsing ? 'Parsing…' : 'Parse'}
          </button>
        </form>
        {parseError && <p className="mt-2 text-xs text-red-500">{parseError}</p>}

        {parsed && (
          <div className="mt-4 p-4 bg-indigo-50 border border-indigo-200 rounded-lg">
            <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wide mb-3">
              Review before saving
            </p>
            <div className="grid grid-cols-2 gap-2 text-sm mb-3">
              <div><span className="text-slate-500">Amount:</span> <span className="font-medium">{fmt(parsed.amount)}</span></div>
              <div><span className="text-slate-500">Type:</span> <span className="font-medium capitalize">{parsed.transaction_type}</span></div>
              {parsed.transaction_type === 'expense' && (
                <div><span className="text-slate-500">Category:</span> <span className="font-medium">{CATEGORY_ICONS[parsed.category]} {CATEGORY_LABELS[parsed.category]}</span></div>
              )}
              <div><span className="text-slate-500">Date:</span> <span className="font-medium">{parsed.date}</span></div>
              <div className="col-span-2"><span className="text-slate-500">Description:</span> <span className="font-medium">{parsed.description}</span></div>
              {parsed.confidence_note && (
                <div className="col-span-2 text-xs text-amber-600 italic">{parsed.confidence_note}</div>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={confirmParsed} disabled={saving} className="px-4 py-1.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                {saving ? 'Saving…' : 'Confirm & save'}
              </button>
              <button onClick={() => { setShowManual(true); setParsed(null) }} className="px-4 py-1.5 bg-white border border-slate-300 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-50">
                Edit
              </button>
              <button onClick={() => setParsed(null)} className="px-4 py-1.5 text-slate-500 text-sm hover:text-slate-700">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Manual add form */}
      {showManual && (
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <p className="text-sm font-semibold text-slate-700 mb-4">Add transaction manually</p>
          <TxFormFields
            form={addForm} onChange={setAddForm}
            onSubmit={handleAdd} onCancel={() => setShowManual(false)}
            saving={saving} submitLabel="Save transaction"
          />
        </div>
      )}

      {/* Recurring transactions */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">Recurring monthly</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Rent, paychecks, subscriptions — posted automatically each month
            </p>
          </div>
          <button
            onClick={() => setShowRecurringForm((v) => !v)}
            className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            {showRecurringForm ? 'Cancel' : '+ Add recurring'}
          </button>
        </div>

        {postedNote && (
          <p className="px-6 py-2 text-xs text-indigo-600 bg-indigo-50/60 border-b border-indigo-100">{postedNote}</p>
        )}

        {showRecurringForm && (
          <form onSubmit={addRecurring} className="px-6 py-4 border-b border-slate-100 flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Amount ($)</label>
              <input
                type="number" step="0.01" min="0.01" required
                value={recForm.amount}
                onChange={(e) => setRecForm({ ...recForm, amount: e.target.value })}
                className="w-28 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="e.g. 800"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Type</label>
              <select
                value={recForm.transaction_type}
                onChange={(e) => setRecForm({ ...recForm, transaction_type: e.target.value as TxType })}
                className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </div>
            {recForm.transaction_type === 'expense' && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Category</label>
                <select
                  value={recForm.category}
                  onChange={(e) => setRecForm({ ...recForm, category: e.target.value })}
                  className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>{CATEGORY_ICONS[c]} {CATEGORY_LABELS[c]}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Day of month</label>
              <select
                value={recForm.day_of_month}
                onChange={(e) => setRecForm({ ...recForm, day_of_month: parseInt(e.target.value) })}
                className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>{ordinal(d)}</option>
                ))}
              </select>
            </div>
            <div className="flex-1 min-w-[140px]">
              <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
              <input
                type="text"
                value={recForm.description}
                onChange={(e) => setRecForm({ ...recForm, description: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder={recForm.transaction_type === 'income' ? 'e.g. Paycheck' : 'e.g. Rent'}
              />
            </div>
            <button
              type="submit" disabled={recSaving}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {recSaving ? 'Saving…' : 'Save'}
            </button>
          </form>
        )}

        {!recurringLoaded ? (
          <p className="px-6 py-5 text-sm text-slate-400">Loading…</p>
        ) : recurring.length === 0 ? (
          <p className="px-6 py-5 text-sm text-slate-400">
            Nothing recurring yet. Add rent or a subscription and it'll log itself every month.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recurring.map((r) => (
              <li key={r.id} className="px-6 py-3 flex items-center justify-between group">
                <div className="flex items-center gap-3">
                  <span
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-base flex-shrink-0"
                    style={{ background: r.transaction_type === 'income' ? '#dcfce7' : '#f1f5f9' }}
                  >
                    {r.transaction_type === 'income' ? '💵' : CATEGORY_ICONS[r.category]}
                  </span>
                  <div>
                    <p className="text-sm font-medium text-slate-800">
                      {r.description || <span className="text-slate-400 italic">No description</span>}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {r.transaction_type === 'income' ? 'Income' : CATEGORY_LABELS[r.category]} · the {ordinal(r.day_of_month)} of every month · next {r.next_date}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-semibold ${r.transaction_type === 'income' ? 'text-green-600' : 'text-slate-800'}`}>
                    {r.transaction_type === 'income' ? '+' : '-'}{fmt(r.amount)}/mo
                  </span>
                  <button
                    onClick={() => deleteRecurring(r)}
                    aria-label="Stop recurring transaction"
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-400 transition-all"
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Transaction list */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-700 flex-shrink-0">All transactions</h3>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by description, category, or date…"
            className="flex-1 px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-slate-50"
          />
        </div>

        {loading ? (
          <div className="divide-y divide-slate-100">
            {[1, 2, 3].map((i) => (
              <div key={i} className="px-6 py-4 flex items-center gap-3 animate-pulse">
                <div className="w-8 h-8 rounded-lg bg-slate-100 flex-shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 bg-slate-100 rounded w-48" />
                  <div className="h-2.5 bg-slate-100 rounded w-32" />
                </div>
                <div className="h-3 bg-slate-100 rounded w-16" />
              </div>
            ))}
          </div>
        ) : transactions.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-3xl mb-2">💳</p>
            <p className="text-slate-600 font-medium text-sm">No transactions yet</p>
            <p className="text-slate-400 text-xs mt-1 mb-4">Add your first one using the parser above or the manual form.</p>
            <button
              onClick={() => setShowManual(true)}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
            >
              + Add manually
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-6 py-8 text-center text-slate-400 text-sm">No transactions match "{search}".</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {filtered.map((tx) =>
              editingId === tx.id ? (
                <li key={tx.id} className="px-6 py-4 bg-indigo-50/40">
                  <p className="text-xs font-semibold text-indigo-600 mb-3">Editing transaction</p>
                  <TxFormFields
                    form={editForm} onChange={setEditForm}
                    onSubmit={handleEdit} onCancel={() => setEditingId(null)}
                    saving={editSaving} submitLabel="Save changes"
                  />
                </li>
              ) : (
                <li key={tx.id} className="px-6 py-3 flex items-center justify-between group">
                  <div className="flex items-center gap-3">
                    <span
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-base flex-shrink-0"
                      style={{ background: tx.transaction_type === 'income' ? '#dcfce7' : '#f1f5f9' }}
                    >
                      {tx.transaction_type === 'income' ? '💵' : CATEGORY_ICONS[tx.category]}
                    </span>
                    <div>
                      <p className="text-sm font-medium text-slate-800">{tx.description || <span className="text-slate-400 italic">No description</span>}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {tx.transaction_type === 'income' ? 'Income' : CATEGORY_LABELS[tx.category]} · {tx.date}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-semibold ${tx.transaction_type === 'income' ? 'text-green-600' : 'text-slate-800'}`}>
                      {tx.transaction_type === 'income' ? '+' : '-'}{fmt(tx.amount)}
                    </span>
                    <button
                      onClick={() => startEdit(tx)}
                      aria-label="Edit transaction"
                      className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-indigo-500 transition-all"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => deleteTransaction(tx.id)}
                      aria-label="Delete transaction"
                      className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-400 transition-all"
                    >
                      ×
                    </button>
                  </div>
                </li>
              )
            )}
          </ul>
        )}
      </div>
    </div>
  )
}
