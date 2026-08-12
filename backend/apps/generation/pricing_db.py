"""Port of src/lib/pricing-db.js — DB-backed pricing access."""

from .models import Pricing


def read_pricing() -> list[dict]:
    return [
        {"model": p.model, "unitCostCents": p.unit_cost_cents, "unit": p.unit, "notes": p.notes}
        for p in Pricing.objects.all()
    ]


def update_pricing(model: str, unit_cost_cents: int, unit: str) -> None:
    Pricing.objects.update_or_create(model=model, defaults={"unit_cost_cents": unit_cost_cents, "unit": unit})
