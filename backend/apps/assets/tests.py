import time
import uuid

from django.test import TestCase

from . import assets_service
from .models import Asset


class AssetsServiceTests(TestCase):
    def test_make_unique_slug_dedupes(self):
        now = int(time.time() * 1000)
        Asset.objects.create(
            id=uuid.uuid4(), kind="prop", name="Sword", slug="sword", images=[],
            created_at=now, updated_at=now,
        )
        self.assertEqual(assets_service.make_unique_slug("Sword"), "sword-2")
        self.assertEqual(assets_service.make_unique_slug("Brand New Thing"), "brand-new-thing")

    def test_make_unique_slug_strips_punctuation(self):
        self.assertEqual(assets_service.make_unique_slug("Priya's Café!!"), "priya-s-caf")
