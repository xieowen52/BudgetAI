from datetime import date
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from supabase import Client

from app.core.database import get_supabase
from app.core.dependencies import get_current_user_id
from app.schemas.plan import (
    AllocationItem,
    FundingMode,
    IncomeChangeCreate,
    IncomeChangeResponse,
    MonthAnalysis,
    MonthCategoryActual,
    PlanAnalysisResponse,
    PlanCreate,
    PlanEventCreate,
    PlanEventResponse,
    PlanIntakeRequest,
    PlanIntakeResponse,
    PlanMonthView,
    PlanPreviewResponse,
    PlanResponse,
    PlanStatusCategory,
    PlanStatusResponse,
    PlanSummary,
)
from app.schemas.transaction import Category
from app.services.allocation import (
    AllocationError,
    AllocationResult,
    IrregularEvent,
    apply_events,
    apply_income_changes,
    compute_allocation,
)
from app.services.plan_advisor import generate_insights
from app.services.plan_intake import extract_plan_from_text

router = APIRouter(prefix="/plans", tags=["plans"])


def _add_months(start: date, months: int) -> date:
    """First day of the month `months` after `start` (start is day 1)."""
    total = start.year * 12 + (start.month - 1) + months
    return date(total // 12, total % 12 + 1, 1)


def _effective_income(payload: PlanCreate) -> Decimal:
    """The monthly amount available to allocate.

    In pot mode there's no income — the fixed pool is divided evenly
    across the plan, so all downstream math (allocation, budgets,
    events) works identically to income mode.
    """
    if payload.funding_mode == FundingMode.pot:
        return round(Decimal(payload.total_funds) / payload.horizon_months, 2)
    return Decimal(payload.monthly_income)


def _run_engine(payload: PlanCreate) -> AllocationResult:
    """Run the allocation engine, translating input errors to 400s."""
    try:
        return compute_allocation(
            monthly_income=_effective_income(payload),
            fixed_expenses={c: Decimal(a) for c, a in payload.fixed_expenses.items()},
            variable_estimates={
                c: Decimal(a) for c, a in payload.variable_estimates.items()
            },
            savings_goal=Decimal(payload.savings_goal),
            horizon_months=payload.horizon_months,
        )
    except AllocationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        )


def _allocation_items(result: AllocationResult) -> list[AllocationItem]:
    return [
        AllocationItem(category=cat, amount=float(amt), is_fixed=True)
        for cat, amt in result.fixed.items()
    ] + [
        AllocationItem(category=cat, amount=float(amt), is_fixed=False)
        for cat, amt in result.variable.items()
    ]


def _summary(result: AllocationResult) -> PlanSummary:
    return PlanSummary(
        monthly_income=float(result.monthly_income),
        fixed_total=float(result.fixed_total),
        monthly_savings=float(result.monthly_savings),
        discretionary=float(result.discretionary),
        unallocated=float(result.unallocated),
    )


def _fetch_plan(user_id: str, db: Client) -> dict:
    """Load the user's plan or raise 404."""
    result = (
        db.table("plans").select("*").eq("user_id", user_id).limit(1).execute()
    )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No budget plan yet. Create one with the planner.",
        )
    return result.data[0]


def _fetch_allocations(plan_id: str, db: Client) -> list[dict]:
    return (
        db.table("plan_allocations")
        .select("month_index, category, amount, is_fixed")
        .eq("plan_id", plan_id)
        .order("month_index")
        .execute()
    ).data


def _fetch_events(plan_id: str, db: Client) -> list[dict]:
    return (
        db.table("plan_events")
        .select("*")
        .eq("plan_id", plan_id)
        .order("created_at")
        .execute()
    ).data


def _fetch_income_changes(plan_id: str, db: Client) -> list[dict]:
    return (
        db.table("plan_income_changes")
        .select("*")
        .eq("plan_id", plan_id)
        .order("month_index")
        .execute()
    ).data


def _adjusted_state(
    plan: dict,
    allocations: list[dict],
    events: list[dict],
    income_changes: list[dict] | None = None,
) -> tuple[dict[int, dict[Category, Decimal]], dict[int, Decimal], dict[int, set[Category]]]:
    """Base allocations + income changes + events -> the adjusted view.

    plan_allocations rows are the untouched base; this overlays the
    stored income changes (first — events must see the income actually
    available) and then events, on every read. Returns (amounts,
    leftover buffer, fixed categories) per month_index.
    """
    horizon = plan["horizon_months"]
    income = Decimal(str(plan["monthly_income"]))
    monthly_savings = round(Decimal(str(plan["savings_goal"])) / horizon, 2)

    amounts: dict[int, dict[Category, Decimal]] = {i: {} for i in range(horizon)}
    fixed: dict[int, set[Category]] = {i: set() for i in range(horizon)}
    for row in allocations:
        cat = Category(row["category"])
        amounts[row["month_index"]][cat] = Decimal(str(row["amount"]))
        if row["is_fixed"]:
            fixed[row["month_index"]].add(cat)

    buffers = {
        i: income - monthly_savings - sum(amounts[i].values(), Decimal("0"))
        for i in range(horizon)
    }

    if income_changes:
        amounts, buffers = apply_income_changes(
            amounts,
            fixed,
            buffers,
            base_income=income,
            monthly_savings=monthly_savings,
            changes={
                c["month_index"]: Decimal(str(c["monthly_amount"]))
                for c in income_changes
            },
        )

    adjusted_amounts, leftover_buffers = apply_events(
        amounts,
        fixed,
        buffers,
        [
            IrregularEvent(
                name=e["name"],
                category=Category(e["category"]),
                amount=Decimal(str(e["amount"])),
                month_index=e["month_index"],
                funding=e["funding"],
            )
            for e in events
        ],
    )
    return adjusted_amounts, leftover_buffers, fixed


def _build_plan_response(
    plan: dict,
    allocations: list[dict],
    events: list[dict],
    income_changes: list[dict] | None = None,
) -> PlanResponse:
    """Assemble the API view of a stored plan.

    Months are the event-adjusted view; the summary stays the base
    monthly arithmetic (income − fixed − savings) so the headline
    numbers don't jump around as events come and go.
    """
    start = date.fromisoformat(plan["start_date"])
    horizon = plan["horizon_months"]
    income = Decimal(str(plan["monthly_income"]))
    savings_goal = Decimal(str(plan["savings_goal"]))
    monthly_savings = round(savings_goal / horizon, 2)

    base_fixed_total = sum(r["amount"] for r in allocations if r["month_index"] == 0 and r["is_fixed"])
    base_variable_total = sum(r["amount"] for r in allocations if r["month_index"] == 0 and not r["is_fixed"])
    discretionary = float(income) - base_fixed_total - float(monthly_savings)

    amounts, buffers, fixed = _adjusted_state(plan, allocations, events, income_changes)

    months = []
    for i in range(horizon):
        month_date = _add_months(start, i)
        items = sorted(
            (
                AllocationItem(
                    category=cat, amount=float(amt), is_fixed=cat in fixed[i]
                )
                for cat, amt in amounts[i].items()
            ),
            key=lambda a: (not a.is_fixed, a.category.value),
        )
        months.append(
            PlanMonthView(
                month_index=i,
                year=month_date.year,
                month=month_date.month,
                allocations=items,
                unallocated=float(buffers[i]),
            )
        )

    return PlanResponse(
        id=plan["id"],
        user_id=plan["user_id"],
        start_date=start,
        horizon_months=horizon,
        savings_goal=float(savings_goal),
        funding_mode=plan.get("funding_mode") or FundingMode.income,
        total_funds=plan.get("total_funds"),
        summary=PlanSummary(
            monthly_income=float(income),
            fixed_total=round(base_fixed_total, 2),
            monthly_savings=float(monthly_savings),
            discretionary=round(discretionary, 2),
            unallocated=round(discretionary - base_variable_total, 2),
        ),
        months=months,
        events=[PlanEventResponse(**e) for e in events],
        income_changes=[IncomeChangeResponse(**c) for c in income_changes or []],
    )


@router.post("/intake", response_model=PlanIntakeResponse)
async def plan_intake(
    payload: PlanIntakeRequest,
    user_id: str = Depends(get_current_user_id),
):
    """Extract wizard fields from a plain-language description.

    Returns structured fields for the client to prefill the wizard with,
    plus follow-up questions when essentials are missing. Does NOT
    persist anything — same parse → confirm pattern as /parse.
    """
    try:
        return await extract_plan_from_text(payload.text, today=date.today())
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        )


@router.post("/preview", response_model=PlanPreviewResponse)
async def preview_plan(
    payload: PlanCreate,
    user_id: str = Depends(get_current_user_id),
):
    """Run the allocation engine without saving anything.

    Powers the wizard's review step so the user sees and can tweak the
    generated budget before committing to it.
    """
    result = _run_engine(payload)
    return PlanPreviewResponse(
        summary=_summary(result), allocations=_allocation_items(result)
    )


def persist_plan(user_id: str, payload: PlanCreate, db: Client) -> dict:
    """Run the engine and write the plan, allocations, and synced budgets.

    Shared by the wizard's create endpoint and the demo seeder so both
    take the identical persistence path. Replaces any existing plan
    (delete cascades to allocations/events/income changes). Returns the
    new plan row. Raises HTTPException(400) on an infeasible budget.
    """
    result = _run_engine(payload)
    start = payload.start_date.replace(day=1)

    db.table("plans").delete().eq("user_id", user_id).execute()
    plan_row = (
        db.table("plans")
        .insert(
            {
                "user_id": user_id,
                "start_date": start.isoformat(),
                "horizon_months": payload.horizon_months,
                "monthly_income": float(result.monthly_income),
                "savings_goal": float(payload.savings_goal),
                "funding_mode": payload.funding_mode.value,
                "total_funds": (
                    float(payload.total_funds)
                    if payload.funding_mode == FundingMode.pot
                    else None
                ),
            }
        )
        .execute()
    ).data[0]

    items = _allocation_items(result)
    rows = [
        {
            "plan_id": plan_row["id"],
            "month_index": month_index,
            "category": item.category.value,
            "amount": item.amount,
            "is_fixed": item.is_fixed,
        }
        for month_index in range(payload.horizon_months)
        for item in items
    ]
    if rows:
        db.table("plan_allocations").insert(rows).execute()

    budget_rows = [
        {
            "user_id": user_id,
            "category": item.category.value,
            "monthly_limit": item.amount,
        }
        for item in items
        if item.amount > 0
    ]
    if budget_rows:
        db.table("budgets").upsert(
            budget_rows, on_conflict="user_id,category"
        ).execute()

    return plan_row


@router.post("/", response_model=PlanResponse, status_code=status.HTTP_201_CREATED)
async def create_plan(
    payload: PlanCreate,
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Create the user's budget plan from the wizard inputs.

    One plan per user: an existing plan is replaced (delete cascades to
    its allocations). Allocations are materialized per month so future
    irregular-event features can adjust individual months.

    Also syncs the plan's per-category amounts into the budgets table so
    the Budgets page's limits and progress bars reflect the plan without
    re-entering them. Deleting a plan leaves budgets in place — they are
    user-editable on their own after creation.
    """
    plan_row = persist_plan(user_id, payload, db)
    return _build_plan_response(plan_row, _fetch_allocations(plan_row["id"], db), [])


@router.get("/current", response_model=PlanResponse)
async def get_current_plan(
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Return the user's plan with event- and income-adjusted months."""
    plan = _fetch_plan(user_id, db)
    return _build_plan_response(
        plan,
        _fetch_allocations(plan["id"], db),
        _fetch_events(plan["id"], db),
        _fetch_income_changes(plan["id"], db),
    )


@router.get("/status", response_model=PlanStatusResponse)
async def plan_status(
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Current-month plan snapshot for the dashboard.

    Compares this month's adjusted planned amounts against month-to-date
    spending. active=False when today falls outside the plan period.
    """
    plan = _fetch_plan(user_id, db)
    start = date.fromisoformat(plan["start_date"])
    today = date.today()
    month_index = (today.year - start.year) * 12 + (today.month - start.month)
    if month_index < 0 or month_index >= plan["horizon_months"]:
        return PlanStatusResponse(active=False)

    amounts, buffers, fixed = _adjusted_state(
        plan,
        _fetch_allocations(plan["id"], db),
        _fetch_events(plan["id"], db),
        _fetch_income_changes(plan["id"], db),
    )

    month_start = date(today.year, today.month, 1)
    transactions = (
        db.table("transactions")
        .select("category, amount")
        .eq("user_id", user_id)
        .eq("transaction_type", "expense")
        .gte("date", month_start.isoformat())
        .lt("date", _add_months(month_start, 1).isoformat())
        .execute()
    ).data
    spent: dict[str, float] = {}
    for tx in transactions:
        spent[tx["category"]] = spent.get(tx["category"], 0.0) + tx["amount"]

    categories = sorted(
        (
            PlanStatusCategory(
                category=cat,
                planned=float(amt),
                spent=round(spent.get(cat.value, 0.0), 2),
                remaining=round(float(amt) - spent.get(cat.value, 0.0), 2),
                is_fixed=cat in fixed[month_index],
            )
            for cat, amt in amounts[month_index].items()
            if amt > 0
        ),
        key=lambda c: c.remaining,  # most over / closest to the line first
    )

    return PlanStatusResponse(
        active=True,
        month_index=month_index,
        days_left=(_add_months(month_start, 1) - today).days,
        categories=categories,
        buffer=float(buffers[month_index]),
    )


@router.post(
    "/events", response_model=PlanResponse, status_code=status.HTTP_201_CREATED
)
async def add_plan_event(
    payload: PlanEventCreate,
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Add a one-time irregular expense to the plan.

    Feasibility is validated before saving: the event (together with
    all existing events) must fit within the affected months' buffers
    plus flexible budgets, otherwise a 400 explains what doesn't fit.
    """
    plan = _fetch_plan(user_id, db)
    if payload.month_index >= plan["horizon_months"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Event month is outside the plan period",
        )

    allocations = _fetch_allocations(plan["id"], db)
    events = _fetch_events(plan["id"], db)
    income_changes = _fetch_income_changes(plan["id"], db)
    candidate = {
        "name": payload.name,
        "category": payload.category.value,
        "amount": float(payload.amount),
        "month_index": payload.month_index,
        "funding": payload.funding.value,
    }
    try:
        _adjusted_state(plan, allocations, events + [candidate], income_changes)
    except AllocationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        )

    db.table("plan_events").insert({**candidate, "plan_id": plan["id"]}).execute()
    return _build_plan_response(
        plan, allocations, _fetch_events(plan["id"], db), income_changes
    )


@router.post(
    "/income-changes", response_model=PlanResponse, status_code=status.HTTP_201_CREATED
)
async def add_income_change(
    payload: IncomeChangeCreate,
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Record an income change from a given month onward.

    Validated before saving: every affected month must still cover its
    fixed costs and savings (and any events must still fit). Upserts on
    (plan_id, month_index) so re-stating a month replaces the old value.
    """
    plan = _fetch_plan(user_id, db)
    if payload.month_index >= plan["horizon_months"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Change month is outside the plan period",
        )

    allocations = _fetch_allocations(plan["id"], db)
    events = _fetch_events(plan["id"], db)
    income_changes = _fetch_income_changes(plan["id"], db)
    candidate = {
        "month_index": payload.month_index,
        "monthly_amount": float(payload.monthly_amount),
    }
    merged = [c for c in income_changes if c["month_index"] != payload.month_index]
    try:
        _adjusted_state(plan, allocations, events, merged + [candidate])
    except AllocationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        )

    db.table("plan_income_changes").upsert(
        {**candidate, "plan_id": plan["id"]}, on_conflict="plan_id,month_index"
    ).execute()
    return _build_plan_response(
        plan, allocations, events, _fetch_income_changes(plan["id"], db)
    )


@router.delete("/income-changes/{change_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_income_change(
    change_id: UUID,
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Remove an income change (ownership checked via the plan).

    Removal can make a previously feasible event infeasible (e.g. a
    raise funded a trip); that's validated too.
    """
    plan = _fetch_plan(user_id, db)
    existing = (
        db.table("plan_income_changes")
        .select("id, month_index")
        .eq("id", str(change_id))
        .eq("plan_id", plan["id"])
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Income change not found"
        )

    remaining = [
        c for c in _fetch_income_changes(plan["id"], db)
        if c["id"] != str(change_id)
    ]
    try:
        _adjusted_state(
            plan,
            _fetch_allocations(plan["id"], db),
            _fetch_events(plan["id"], db),
            remaining,
        )
    except AllocationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Removing this change breaks the plan: {exc}",
        )
    db.table("plan_income_changes").delete().eq("id", str(change_id)).execute()


@router.delete("/events/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plan_event(
    event_id: UUID,
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Remove an irregular event (ownership checked via the plan)."""
    plan = _fetch_plan(user_id, db)
    existing = (
        db.table("plan_events")
        .select("id")
        .eq("id", str(event_id))
        .eq("plan_id", plan["id"])
        .limit(1)
        .execute()
    )
    if not existing.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Event not found"
        )
    db.table("plan_events").delete().eq("id", str(event_id)).execute()


@router.delete("/current", status_code=status.HTTP_204_NO_CONTENT)
async def delete_current_plan(
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Delete the user's plan (allocations cascade)."""
    _fetch_plan(user_id, db)
    db.table("plans").delete().eq("user_id", user_id).execute()


@router.get("/analysis", response_model=PlanAnalysisResponse)
async def analyze_plan(
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Compare planned vs. actual spending for each complete plan month.

    All aggregation is deterministic; Claude only narrates the computed
    numbers (and is skipped gracefully when no API key is configured).
    """
    plan = _fetch_plan(user_id, db)
    start = date.fromisoformat(plan["start_date"])
    horizon = plan["horizon_months"]
    monthly_savings = round(plan["savings_goal"] / horizon, 2)

    # Only analyze months that have fully elapsed — partial months would
    # make every category look under budget.
    today = date.today()
    complete_months = 0
    while complete_months < horizon and _add_months(start, complete_months + 1) <= today:
        complete_months += 1

    if complete_months == 0:
        return PlanAnalysisResponse(
            months_analyzed=0,
            months=[],
            consistently_over=[],
            consistently_under=[],
            insights_note=(
                "Analysis unlocks after your first full month on the plan. "
                "Keep logging transactions!"
            ),
        )

    # Planned amounts are the event-adjusted view, so a planned one-time
    # expense (a flight, a laptop) isn't flagged as overspending.
    allocations = _fetch_allocations(plan["id"], db)
    events = _fetch_events(plan["id"], db)
    income_changes = _fetch_income_changes(plan["id"], db)
    amounts, _, _ = _adjusted_state(plan, allocations, events, income_changes)
    planned: dict[int, dict[str, float]] = {
        i: {cat.value: float(amt) for cat, amt in amounts[i].items()}
        for i in range(complete_months)
    }

    transactions = (
        db.table("transactions")
        .select("amount, category, date, transaction_type")
        .eq("user_id", user_id)
        .gte("date", start.isoformat())
        .lt("date", _add_months(start, complete_months).isoformat())
        .execute()
    ).data

    # Bucket actuals as {month_index: {category: spent}} plus income per month
    spent: dict[int, dict[str, float]] = {i: {} for i in range(complete_months)}
    income_actual: dict[int, float] = {i: 0.0 for i in range(complete_months)}
    for tx in transactions:
        tx_date = date.fromisoformat(tx["date"])
        idx = (tx_date.year - start.year) * 12 + (tx_date.month - start.month)
        if tx["transaction_type"] == "income":
            income_actual[idx] += tx["amount"]
        else:
            spent[idx][tx["category"]] = spent[idx].get(tx["category"], 0.0) + tx["amount"]

    # Pot mode: track the pool's actual balance against where it should
    # be if each month spent exactly its (event-adjusted) budget.
    funding_mode = plan.get("funding_mode") or FundingMode.income
    is_pot = funding_mode == FundingMode.pot
    remaining = float(plan["total_funds"]) if is_pot else 0.0
    expected = float(plan["total_funds"]) if is_pot else 0.0

    months: list[MonthAnalysis] = []
    over_counts: dict[str, int] = {}
    under_counts: dict[str, int] = {}
    for i in range(complete_months):
        month_date = _add_months(start, i)
        categories = []
        for cat, planned_amt in sorted(planned.get(i, {}).items()):
            actual = round(spent[i].get(cat, 0.0), 2)
            categories.append(
                MonthCategoryActual(
                    category=cat,
                    planned=planned_amt,
                    actual=actual,
                    difference=round(planned_amt - actual, 2),
                )
            )
            if actual > planned_amt:
                over_counts[cat] = over_counts.get(cat, 0) + 1
            else:
                under_counts[cat] = under_counts.get(cat, 0) + 1
        expenses_total = round(sum(spent[i].values()), 2)
        if is_pot:
            remaining = round(remaining + income_actual[i] - expenses_total, 2)
            expected = round(expected - sum(planned.get(i, {}).values()), 2)
        months.append(
            MonthAnalysis(
                month_index=i,
                year=month_date.year,
                month=month_date.month,
                income_actual=round(income_actual[i], 2),
                expenses_actual=expenses_total,
                savings_actual=round(income_actual[i] - expenses_total, 2),
                savings_planned=monthly_savings,
                categories=categories,
                remaining_funds=remaining if is_pot else None,
                expected_remaining=expected if is_pot else None,
            )
        )

    # "Consistent" = over (or under) budget in at least 2/3 of the months
    threshold = complete_months * 2 / 3
    consistently_over = sorted(c for c, n in over_counts.items() if n >= threshold)
    consistently_under = sorted(
        c for c, n in under_counts.items() if n >= threshold and c not in consistently_over
    )

    response = PlanAnalysisResponse(
        funding_mode=funding_mode,
        months_analyzed=complete_months,
        months=months,
        consistently_over=[Category(c) for c in consistently_over],
        consistently_under=[Category(c) for c in consistently_under],
    )

    # AI narration is best-effort: a Claude failure should never take
    # down the deterministic numbers.
    try:
        response.insights = await generate_insights(
            response.model_dump(mode="json", exclude={"insights", "insights_note"})
        )
        if response.insights is None:
            response.insights_note = "AI insights disabled (no ANTHROPIC_API_KEY set)."
    except Exception:
        response.insights_note = "AI insights are temporarily unavailable."

    return response
