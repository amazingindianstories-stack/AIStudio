"""Seedream 5.5 layer decomposition result persistence and public shape."""
from django.test import TestCase
from apps.common.leases import now_ms
from .models import Generation
from .serialization import generation_item


class LayerSerializationTests(TestCase):
    def row(self, **fields):
        stamp = now_ms()
        return Generation.objects.create(kind='image', status='succeeded', prompt='split', model='Seedream 5.5', aspect_ratio='1:1',
                                         created_at=stamp, updated_at=stamp, **fields)

    def test_layers_and_options_round_trip_for_reopening(self):
        layers = [{'url': 'u1', 'zIndex': 1, 'width': 10, 'height': 20, 'textRecognition': {'text': 'Hi'}}]
        row = self.row(url='base', layers=layers, submission_input={'layers': {'maxImages': 15, 'textRecognition': True}})
        item = generation_item(Generation.objects.get(pk=row.pk), filename='x.png')
        self.assertEqual(item['layers'], layers)
        self.assertEqual(item['imageLayers'], {'maxImages': 15, 'textRecognition': True})

    def test_plain_images_have_no_layer_fields(self):
        item = generation_item(self.row(url='base'), filename='x.png')
        self.assertNotIn('layers', item)
        self.assertNotIn('imageLayers', item)
