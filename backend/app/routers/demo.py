"""Demo data: backfill a coherent financial history in one click.

The analysis, burn-rate, and plan-check features only come alive after a
month of real data, which makes a fresh account look empty. This seeds a
backdated plan plus a few months of realistic transactions (with a couple
of categories deliberately over budget so the analysis has something to
surface) so every feature is demoable immediately.

Both endpoints first wipe the user's own financial data — they're
destructive by design, so the client confirms before calling.
"""

from datetime import date

from fastapi import APIRouter, Depends
from supabase import Client

from app.core.database import get_supabase
from app.core.dependencies import get_current_user_id
from app.routers.plans import persist_plan
from app.schemas.plan import FundingMode, PlanCreate
from app.schemas.transaction import Category, TransactionType

router = APIRouter(prefix="/demo", tags=["demo"])

# A realistic student profile. Estimates feed the allocation engine;
# actuals (below) are intentionally a bit different so analysis can flag
# over/under categories.
DEMO_INCOME = 2200
DEMO_SAVINGS_GOAL = 1200  # over 6 months -> 200/mo set aside
DEMO_FIXED = {Category.housing: 900, Category.subscriptions: 30}
DEMO_ESTIMATES = {
    Category.food: 350,
    Category.transport: 150,
    Category.entertainment: 120,
    Category.shopping: 150,
    Category.health: 60,
    Category.other: 40,
}

# Per-elapsed-month actual spend per category. Food runs consistently
# over its 350 budget; entertainment over its 120; health under its 60.
DEMO_MONTHLY_ACTUALS = [
    {Category.food: 410, Category.transport: 140, Category.entertainment: 165,
     Category.shopping: 90, Category.health: 50, Category.other: 40},
    {Category.food: 445, Category.transport: 160, Category.entertainment: 130,
     Category.shopping: 200, Category.health: 0, Category.other: 35},
    {Category.food: 390, Category.transport: 130, Category.entertainment: 155,
     Category.shopping: 110, Category.health: 55, Category.other: 60},
]
# Current (partial) month, ~mid-month so far.
DEMO_PARTIAL_ACTUALS = {
    Category.food: 210, Category.transport: 70, Category.entertainment: 80,
    Category.shopping: 0, Category.health: 0, Category.other: 25,
}

_LABELS = {
    Category.food: ["Groceries", "Coffee & lunch"],
    Category.transport: ["Gas", "Uber rides"],
    Category.entertainment: ["Movie & games", "Concert ticket"],
    Category.shopping: ["Amazon order", "New clothes"],
    Category.health: ["Pharmacy", "Gym"],
    Category.other: ["Misc", "Gift"],
}


def _add_months(d: date, months: int) -> date:
    total = d.year * 12 + (d.month - 1) + months
    return date(total // 12, total % 12 + 1, 1)


def _split_transactions(month_start: date, actuals: dict[Category, float]) -> list[dict]:
    """Turn a month's per-category totals into individual transactions,
    splitting larger amounts into two and spreading them across the month."""
    rows = []
    for cat, total in actuals.items():
        if total <= 0:
            continue
        labels = _LABELS[cat]
        if total >= 120:
            parts = [(round(total * 0.6, 2), 8), (round(total * 0.4, 2), 22)]
        else:
            parts = [(float(total), 14)]
        for i, (amount, day) in enumerate(parts):
            rows.append({
                "amount": amount,
                "category": cat.value,
                "description": labels[i % len(labels)],
                "date": month_start.replace(day=day).isoformat(),
                "transaction_type": TransactionType.expense.value,
            })
    return rows


def _clear_financial_data(user_id: str, db: Client) -> None:
    """Wipe the user's transactions, plan (cascades), budgets, recurring."""
    db.table("transactions").delete().eq("user_id", user_id).execute()
    db.table("plans").delete().eq("user_id", user_id).execute()
    db.table("budgets").delete().eq("user_id", user_id).execute()
    db.table("recurring_transactions").delete().eq("user_id", user_id).execute()


@router.post("/seed")
async def seed_demo(
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Replace the user's data with a demo financial history.

    Creates a plan backdated 3 months (so 3 full months have elapsed for
    analysis), seeds transactions across those months plus the current
    partial month, and sets up recurring rent + paycheck for the future.
    """
    _clear_financial_data(user_id, db)

    today = date.today()
    start = _add_months(date(today.year, today.month, 1), -3)

    persist_plan(
        user_id,
        PlanCreate(
            funding_mode=FundingMode.income,
            monthly_income=DEMO_INCOME,
            start_date=start,
            horizon_months=6,
            savings_goal=DEMO_SAVINGS_GOAL,
            fixed_expenses=DEMO_FIXED,
            variable_estimates=DEMO_ESTIMATES,
        ),
        db,
    )

    # Transactions for the 3 complete months + the current partial month
    tx_rows: list[dict] = []
    for offset, actuals in enumerate(DEMO_MONTHLY_ACTUALS):
        month_start = _add_months(start, offset)
        tx_rows.extend(_split_transactions(month_start, actuals))
    current_start = _add_months(start, 3)
    tx_rows.extend(_split_transactions(current_start, DEMO_PARTIAL_ACTUALS))

    # Fixed costs + paycheck for every month including the current one
    for offset in range(4):
        month_start = _add_months(start, offset)
        tx_rows.append({
            "amount": DEMO_INCOME, "category": Category.other.value,
            "description": "Paycheck", "date": month_start.replace(day=1).isoformat(),
            "transaction_type": TransactionType.income.value,
        })
        tx_rows.append({
            "amount": DEMO_FIXED[Category.housing], "category": Category.housing.value,
            "description": "Rent", "date": month_start.replace(day=1).isoformat(),
            "transaction_type": TransactionType.expense.value,
        })
        tx_rows.append({
            "amount": DEMO_FIXED[Category.subscriptions], "category": Category.subscriptions.value,
            "description": "Subscriptions", "date": month_start.replace(day=3).isoformat(),
            "transaction_type": TransactionType.expense.value,
        })

    db.table("transactions").insert(
        [{**r, "user_id": user_id} for r in tx_rows]
    ).execute()

    # Recurring rent + paycheck so the next month posts itself. First
    # occurrence is next month (day 1 has passed), so no double-posting.
    db.table("recurring_transactions").insert([
        {
            "user_id": user_id, "amount": DEMO_FIXED[Category.housing],
            "category": Category.housing.value, "description": "Rent",
            "transaction_type": TransactionType.expense.value,
            "day_of_month": 1, "next_date": _add_months(start, 4).isoformat(),
        },
        {
            "user_id": user_id, "amount": DEMO_INCOME,
            "category": Category.other.value, "description": "Paycheck",
            "transaction_type": TransactionType.income.value,
            "day_of_month": 1, "next_date": _add_months(start, 4).isoformat(),
        },
    ]).execute()

    return {"transactions_created": len(tx_rows), "plan_start": start.isoformat()}


@router.delete("/clear", status_code=204)
async def clear_demo(
    user_id: str = Depends(get_current_user_id),
    db: Client = Depends(get_supabase),
):
    """Wipe all of the user's transactions, plan, budgets, and recurring."""
    _clear_financial_data(user_id, db)
