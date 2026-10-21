"""Deployed processes only read prices; the API also lists default models that have no stored price yet."""
from django.test import TestCase, override_settings
from . import queries
from .models import Pricing


class PricingReadTests(TestCase):
    def test_pricing_reads_never_write(self):
        with override_settings(VEEVEE_RUNTIME_COMPONENT='generation'):
            self.assertEqual(queries.price_rows(), [])
            self.assertEqual(Pricing.objects.count(), 0)
        with override_settings(VEEVEE_RUNTIME_COMPONENT='api'):
            self.assertEqual(queries.price_rows(), [dict(row) for row in queries.DEFAULT_PRICING])
            self.assertEqual(Pricing.objects.count(), 0)

    def test_stored_prices_win_and_the_api_appends_only_missing_defaults(self):
        default = queries.DEFAULT_PRICING[0]
        Pricing.objects.create(model=default['model'], unit_cost_cents=999, unit='per_image', notes='edited')
        Pricing.objects.create(model='Retired Model', unit_cost_cents=1, unit='per_image', notes='')
        stored = [{'model': row.model, 'unitCostCents': row.unit_cost_cents, 'unit': row.unit, 'notes': row.notes} for row in Pricing.objects.all()]
        for component in ('generation', 'export', 'scheduler'):
            with override_settings(VEEVEE_RUNTIME_COMPONENT=component):
                self.assertEqual(queries.price_rows(), stored, component)
        with override_settings(VEEVEE_RUNTIME_COMPONENT='api'):
            self.assertEqual(queries.price_rows(), stored + [dict(row) for row in queries.DEFAULT_PRICING[1:]])
        self.assertEqual(Pricing.objects.count(), 2)

    def test_outside_a_deployed_process_the_defaults_are_seeded(self):
        self.assertEqual(len(queries.price_rows()), len(queries.DEFAULT_PRICING))
        self.assertEqual(Pricing.objects.count(), len(queries.DEFAULT_PRICING))
