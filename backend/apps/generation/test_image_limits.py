"""Image dimensions come from the header alone, whatever the size or format of the file."""
import io
import os
from unittest.mock import patch

from django.test import SimpleTestCase
from PIL import Image, ImageFile

from . import image_limits


def noisy_png(side):
    out = io.BytesIO()
    Image.frombytes('RGB', (side, side), os.urandom(side * side * 3)).save(out, format='PNG')
    return out.getvalue()


def chunked(data, size=64 * 1024):
    return (data[index:index + size] for index in range(0, len(data), size))


class HeaderOnlyDimensionTests(SimpleTestCase):
    def test_a_png_larger_than_the_header_budget_is_measured_without_decoding_it(self):
        data = noisy_png(1500)
        self.assertGreater(len(data), image_limits.HEADER_BYTES)
        with patch.object(ImageFile.ImageFile, 'load', side_effect=AssertionError('the pixels were decoded')):
            self.assertEqual(image_limits.dimensions(chunked(data)), (1500, 1500))

    def test_exif_orientation_still_swaps_a_jpeg(self):
        out = io.BytesIO()
        exif = Image.Exif()
        exif[0x0112] = 6
        Image.new('RGB', (640, 400)).save(out, format='JPEG', exif=exif)
        self.assertEqual(image_limits.dimensions(chunked(out.getvalue())), (400, 640))

    def test_a_png_is_never_swapped(self):
        out = io.BytesIO()
        exif = Image.Exif()
        exif[0x0112] = 6
        Image.new('RGB', (640, 400)).save(out, format='PNG', exif=exif)
        self.assertEqual(image_limits.dimensions(chunked(out.getvalue())), (640, 400))

    def test_unreadable_bytes_give_none(self):
        self.assertIsNone(image_limits.dimensions([b'not an image' * 10]))
