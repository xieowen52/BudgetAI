import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../api/client'
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  type Category,
  type FundingMode,
  type IntakeEvent,
  type PlanCreatePayload,
  type PlanIntake,
  type PlanPreview,
} from '../types'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Name of the calendar month at `index` months after the plan start
 *  (plans always start on the 1st of the current month). */
function monthName(index: number) {
  const d = new Date()
  return MONTHS[(d.getMonth() + index) % 12]
}

function fmt(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

const FIXED_CATEGORIES: Category[] = ['housing', 'subscriptions']
const VARIABLE_CATEGORIES: Category[] = [
  'food', 'transport', 'entertainment', 'shopping', 'health', 'other',
]

const FIXED_HINTS: Record<string, string> = {
  housing: 'Rent, utilities, internet — same every month',
  subscriptions: 'Spotify, iCloud, streaming — anything recurring',
}

const STEPS = ['Income', 'Fixed costs', 'Spending', 'Savings', 'Review'] as const

/** Multi-step guided flow that collects financial info and generates a
 *  budget plan. The math is done server-side by the deterministic
 *  allocation engine; the Review step shows a /plans/preview result so
 *  the user sees the full breakdown before anything is saved. */
export default function PlanWizardPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [error, setError] = useState('')

  const [fundingMode, setFundingMode] = useState<FundingMode>('income')
  const [income, setIncome] = useState('')
  const [totalFunds, setTotalFunds] = useState('')
  const [horizon, setHorizon] = useState(6)
  const [fixed, setFixed] = useState<Partial<Record<Category, string>>>({})
  const [variable, setVariable] = useState<Partial<Record<Category, string>>>({})
  const [savingsGoal, setSavingsGoal] = useState('')

  const [preview, setPreview] = useState<PlanPreview | null>(null)
  const [loading, setLoading] = useState(false)

  // Conversational intake: describe your situation, Claude extracts the
  // wizard fields, and you land on the review step to confirm/edit.
  const [view, setView] = useState<'intake' | 'steps'>('intake')
  const [intakeText, setIntakeText] = useState('')
  const [intakeLoading, setIntakeLoading] = useState(false)
  const [intakeQuestions, setIntakeQuestions] = useState<string[]>([])
  const [intakeNote, setIntakeNote] = useState('')
  const [pendingEvents, setPendingEvents] = useState<IntakeEvent[]>([])

  // Errors describe the inputs at the moment they were submitted; once
  // the user navigates to change something, the message is stale.
  function goToStep(next: number) {
    setError('')
    setStep(next)
  }

  function buildPayload(): PlanCreatePayload {
    const startOfMonth = new Date()
    const start = `${startOfMonth.getFullYear()}-${String(startOfMonth.getMonth() + 1).padStart(2, '0')}-01`
    const numericEntries = (obj: Partial<Record<Category, string>>) =>
      Object.fromEntries(
        Object.entries(obj)
          .map(([c, v]) => [c, parseFloat(v || '0')])
          .filter(([, v]) => (v as number) > 0)
      )
    return {
      funding_mode: fundingMode,
      ...(fundingMode === 'income'
        ? { monthly_income: parseFloat(income) }
        : { total_funds: parseFloat(totalFunds) }),
      start_date: start,
      horizon_months: horizon,
      savings_goal: parseFloat(savingsGoal || '0'),
      fixed_expenses: numericEntries(fixed),
      variable_estimates: numericEntries(variable),
    }
  }

  async function goToReview() {
    setLoading(true)
    setError('')
    try {
      const res = await api.post<PlanPreview>('/plans/preview', buildPayload())
      setPreview(res.data)
      setStep(4)
    } catch (err: any) {
      setError(err.response?.data?.detail ?? 'Could not generate a preview')
    } finally {
      setLoading(false)
    }
  }

  async function runIntake() {
    setIntakeLoading(true)
    setError('')
    try {
      const res = await api.post<PlanIntake>('/plans/intake', { text: intakeText })
      const r = res.data

      // Prefill the wizard so every step is editable afterwards
      if (r.funding_mode) setFundingMode(r.funding_mode)
      if (r.monthly_income) setIncome(String(r.monthly_income))
      if (r.total_funds) setTotalFunds(String(r.total_funds))
      if (r.horizon_months) setHorizon(r.horizon_months)
      if (r.savings_goal) setSavingsGoal(String(r.savings_goal))
      setFixed(Object.fromEntries(Object.entries(r.fixed_expenses).map(([c, v]) => [c, String(v)])))
      setVariable(Object.fromEntries(Object.entries(r.variable_estimates).map(([c, v]) => [c, String(v)])))
      setPendingEvents(r.events)
      setIntakeNote(r.confidence_note ?? '')

      const hasFunding =
        (r.funding_mode === 'income' && r.monthly_income) ||
        (r.funding_mode === 'pot' && r.total_funds)

      if (!hasFunding || r.follow_up_questions.length > 0) {
        // Essentials missing — show the questions and let the user add detail
        setIntakeQuestions(
          r.follow_up_questions.length > 0
            ? r.follow_up_questions
            : ['How is this period funded — monthly income, or a fixed amount of savings? Roughly how much?']
        )
        return
      }

      // Build the payload from the extraction directly (state updates
      // above land asynchronously) and jump straight to review
      const payload: PlanCreatePayload = {
        funding_mode: r.funding_mode!,
        ...(r.funding_mode === 'income'
          ? { monthly_income: r.monthly_income! }
          : { total_funds: r.total_funds! }),
        start_date: buildPayload().start_date,
        horizon_months: r.horizon_months ?? 6,
        savings_goal: r.savings_goal ?? 0,
        fixed_expenses: r.fixed_expenses,
        variable_estimates: r.variable_estimates,
      }
      const previewRes = await api.post<PlanPreview>('/plans/preview', payload)
      setPreview(previewRes.data)
      setView('steps')
      setStep(4)
    } catch (err: any) {
      setError(err.response?.data?.detail ?? 'Could not understand the description — try adding more detail')
    } finally {
      setIntakeLoading(false)
    }
  }

  async function createPlan() {
    setLoading(true)
    setError('')
    try {
      await api.post('/plans/', buildPayload())
      // Add any events extracted during intake; a failing event (e.g.
      // doesn't fit the budget) shouldn't block the plan itself
      const failed: string[] = []
      for (const ev of pendingEvents) {
        try {
          await api.post('/plans/events', ev)
        } catch {
          failed.push(ev.name)
        }
      }
      if (failed.length > 0) {
        alert(`Plan created, but these events didn't fit the budget and were skipped: ${failed.join(', ')}. You can add them from the plan page.`)
      }
      navigate('/plan')
    } catch (err: any) {
      setError(err.response?.data?.detail ?? 'Could not create the plan')
      setLoading(false)
    }
  }

  const incomeValid =
    fundingMode === 'income' ? parseFloat(income) > 0 : parseFloat(totalFunds) > 0
  const monthlySavings = parseFloat(savingsGoal || '0') / horizon
  const monthlyDraw = parseFloat(totalFunds || '0') / horizon

  function amountInput(
    value: string,
    onChange: (v: string) => void,
    placeholder: string
  ) {
    return (
      <input
        type="number"
        step="0.01"
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-32 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Create your budget plan</h2>
        <p className="text-sm text-slate-500">
          Answer a few questions and we'll build a month-by-month budget for you
        </p>
      </div>

      {view === 'intake' ? (
        <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
          <div>
            <h3 className="font-semibold text-slate-800">✨ Describe your situation</h3>
            <p className="text-sm text-slate-500 mt-1">
              Tell us about your money in plain English — income or savings, rent,
              subscriptions, goals, trips you're planning — and we'll fill in the
              plan for you. You'll review everything before it's saved.
            </p>
          </div>
          {intakeQuestions.length > 0 && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-lg px-4 py-3 space-y-1">
              <p className="text-xs font-semibold text-indigo-700">A couple more things:</p>
              {intakeQuestions.map((q, i) => (
                <p key={i} className="text-sm text-indigo-700">• {q}</p>
              ))}
            </div>
          )}
          <textarea
            value={intakeText}
            onChange={(e) => setIntakeText(e.target.value)}
            rows={5}
            placeholder={`e.g. "I'm a student with about $10k saved, no income until May. Rent is $800, I pay ~$15/month for subscriptions. I want at least $2k left at the end, and I'm going to Japan in March, probably $1,500."`}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex items-center justify-between">
            <button
              onClick={() => { setError(''); setView('steps') }}
              className="text-sm font-medium text-slate-500 hover:text-slate-700 transition-colors"
            >
              Skip — fill it in manually
            </button>
            <button
              onClick={runIntake}
              disabled={intakeLoading || intakeText.trim().length < 10}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {intakeLoading ? 'Reading…' : intakeQuestions.length > 0 ? 'Update my plan →' : 'Build my plan →'}
            </button>
          </div>
        </div>
      ) : (
      <>
      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                i === step
                  ? 'bg-indigo-600 text-white'
                  : i < step
                    ? 'bg-indigo-50 text-indigo-600'
                    : 'bg-slate-100 text-slate-400'
              }`}
            >
              <span>{i + 1}</span>
              <span className="hidden sm:inline">{label}</span>
            </div>
            {i < STEPS.length - 1 && <div className="w-4 h-px bg-slate-200" />}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
        {step === 0 && (
          <>
            <div>
              <h3 className="font-semibold text-slate-800">Your money</h3>
              <p className="text-sm text-slate-500 mt-1">
                How is this stretch of time funded?
              </p>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setFundingMode('income')}
                className={`text-left p-3 rounded-lg border text-sm transition-colors ${
                  fundingMode === 'income'
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                <span className="font-medium block">💵 I have monthly income</span>
                <span className="text-xs opacity-75">Paychecks, allowance, regular side gigs</span>
              </button>
              <button
                type="button"
                onClick={() => setFundingMode('pot')}
                className={`text-left p-3 rounded-lg border text-sm transition-colors ${
                  fundingMode === 'pot'
                    ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                <span className="font-medium block">🏦 I'm living off savings</span>
                <span className="text-xs opacity-75">A fixed amount that has to last — no income for now</span>
              </button>
            </div>
            {fundingMode === 'income' ? (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Monthly income ($)
                </label>
                {amountInput(income, setIncome, 'e.g. 2000')}
                <p className="text-xs text-slate-400 mt-1">
                  If it varies, use a low-ish estimate — better to budget conservatively.
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Total cash to last the whole plan ($)
                </label>
                {amountInput(totalFunds, setTotalFunds, 'e.g. 10000')}
                {monthlyDraw > 0 && (
                  <p className="text-xs text-indigo-600 font-medium mt-1">
                    That's {fmt(monthlyDraw)}/month to live on for {horizon} months.
                  </p>
                )}
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Plan length
              </label>
              <select
                value={horizon}
                onChange={(e) => setHorizon(parseInt(e.target.value))}
                className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {![3, 6, 12].includes(horizon) && (
                  <option value={horizon}>{horizon} months</option>
                )}
                <option value={3}>3 months</option>
                <option value={6}>6 months (recommended)</option>
                <option value={12}>12 months</option>
              </select>
              <p className="text-xs text-slate-400 mt-1">
                6 months matches a semester — most students' finances reset on that rhythm.
              </p>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div>
              <h3 className="font-semibold text-slate-800">Fixed costs</h3>
              <p className="text-sm text-slate-500 mt-1">
                Bills that are the same every month. These come off the top of
                your income before anything else gets budgeted, so you never
                accidentally plan to spend rent money.
              </p>
            </div>
            {FIXED_CATEGORIES.map((cat) => (
              <div key={cat} className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-slate-700">
                    {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
                  </span>
                  <p className="text-xs text-slate-400">{FIXED_HINTS[cat]}</p>
                </div>
                {amountInput(fixed[cat] ?? '', (v) => setFixed({ ...fixed, [cat]: v }), '0')}
              </div>
            ))}
            <p className="text-xs text-slate-400">
              Don't pay rent? Leave it at 0 — lucky you.
            </p>
          </>
        )}

        {step === 2 && (
          <>
            <div>
              <h3 className="font-semibold text-slate-800">Everyday spending</h3>
              <p className="text-sm text-slate-500 mt-1">
                Roughly what you spend per month in each area. Not sure?{' '}
                <span className="font-medium text-slate-600">
                  Leave them blank and we'll suggest a split
                </span>{' '}
                based on what's left after fixed costs and savings.
              </p>
            </div>
            {VARIABLE_CATEGORIES.map((cat) => (
              <div key={cat} className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">
                  {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
                </span>
                {amountInput(variable[cat] ?? '', (v) => setVariable({ ...variable, [cat]: v }), 'auto')}
              </div>
            ))}
          </>
        )}

        {step === 3 && (
          <>
            <div>
              <h3 className="font-semibold text-slate-800">
                {fundingMode === 'pot' ? 'Safety margin' : 'Savings goal'}
              </h3>
              <p className="text-sm text-slate-500 mt-1">
                {fundingMode === 'pot'
                  ? "How much should still be in the bank when the plan ends? Don't budget down to zero — leaving a cushion is what keeps a surprise expense from becoming a crisis."
                  : 'How much do you want to have saved by the end of the plan? We treat savings like a bill — set aside first, not whatever happens to be left over. That\'s the single habit that makes budgets actually work.'}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                {fundingMode === 'pot'
                  ? `Amount left after ${horizon} months ($)`
                  : `Total goal over ${horizon} months ($)`}
              </label>
              {amountInput(savingsGoal, setSavingsGoal, 'e.g. 1200')}
            </div>
            {parseFloat(savingsGoal) > 0 && (
              <p className="text-sm text-indigo-600 font-medium">
                {fundingMode === 'pot'
                  ? `That's ${fmt(monthlySavings)}/month kept out of the spending budget.`
                  : `That's ${fmt(monthlySavings)}/month set aside automatically.`}
              </p>
            )}
            <p className="text-xs text-slate-400">
              No goal yet? Leave it at 0 — you can always recreate the plan later.
            </p>
          </>
        )}

        {step === 4 && preview && (
          <>
            <div>
              <h3 className="font-semibold text-slate-800">Your plan</h3>
              <p className="text-sm text-slate-500 mt-1">
                Here's the monthly breakdown. Nothing is saved yet — go back
                and adjust if something looks off.
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                [fundingMode === 'pot' ? 'Monthly draw' : 'Income', preview.summary.monthly_income],
                ['Fixed costs', preview.summary.fixed_total],
                [fundingMode === 'pot' ? 'Kept aside' : 'Savings', preview.summary.monthly_savings],
                ['To spend', preview.summary.discretionary],
              ].map(([label, value]) => (
                <div key={label as string} className="bg-slate-50 rounded-lg p-3">
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className="text-sm font-semibold text-slate-900">{fmt(value as number)}</p>
                </div>
              ))}
            </div>
            {preview.summary.discretionary <= 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
                ⚠️ This leaves {preview.summary.discretionary < 0 ? 'less than' : ''} $0 for everyday
                spending — food, transport, and everything else. Consider lowering your
                {fundingMode === 'pot' ? ' safety margin' : ' savings goal'} or fixed costs.
              </div>
            )}
            <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
              {preview.allocations.map((a) => (
                <div key={a.category} className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-sm text-slate-700">
                    {CATEGORY_ICONS[a.category]} {CATEGORY_LABELS[a.category]}
                    {a.is_fixed && (
                      <span className="ml-2 text-xs font-medium px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">
                        fixed
                      </span>
                    )}
                  </span>
                  <span className="text-sm font-medium text-slate-900">{fmt(a.amount)}/mo</span>
                </div>
              ))}
            </div>
            {preview.summary.unallocated > 0 && (
              <p className="text-xs text-slate-500">
                💡 {fmt(preview.summary.unallocated)}/month is left unassigned — a
                built-in buffer for surprises (or extra savings).
              </p>
            )}
            {pendingEvents.length > 0 && (
              <div className="border border-slate-200 rounded-lg px-4 py-3 space-y-1">
                <p className="text-xs font-semibold text-slate-600">One-time events to add:</p>
                {pendingEvents.map((ev, i) => (
                  <p key={i} className="text-sm text-slate-600">
                    {CATEGORY_ICONS[ev.category]} {ev.name} — {fmt(ev.amount)} in {monthName(ev.month_index)}
                    {ev.funding === 'spread' ? ' (saving up for it)' : ' (absorbed that month)'}
                  </p>
                ))}
              </div>
            )}
            {intakeNote && (
              <p className="text-xs text-slate-400">🤖 {intakeNote}</p>
            )}
          </>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        {/* Navigation */}
        <div className="flex justify-between pt-2">
          <button
            onClick={() => goToStep(step - 1)}
            disabled={step === 0 || loading}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 disabled:opacity-0 transition-colors"
          >
            ← Back
          </button>
          {step < 3 && (
            <button
              onClick={() => goToStep(step + 1)}
              disabled={step === 0 && !incomeValid}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              Next →
            </button>
          )}
          {step === 3 && (
            <button
              onClick={goToReview}
              disabled={loading}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Calculating…' : 'Preview my plan →'}
            </button>
          )}
          {step === 4 && (
            <button
              onClick={createPlan}
              disabled={loading}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Saving…' : 'Create plan ✓'}
            </button>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  )
}
