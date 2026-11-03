from django.test import SimpleTestCase

from .uploads import _sniff


class BoardFileSignatureTests(SimpleTestCase):
    def test_svg_psd_and_pdf_are_recognised_by_content(self):
        self.assertTrue(_sniff(b'<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'))
        self.assertTrue(_sniff(b'\xef\xbb\xbf\n <?xml version="1.0"?><svg/>', 'image/svg+xml'))
        self.assertTrue(_sniff(b'8BPS\x00\x01', 'image/vnd.adobe.photoshop'))
        self.assertTrue(_sniff(b'%PDF-1.7\n', 'application/pdf'))

    def test_other_content_is_refused_under_those_types(self):
        self.assertFalse(_sniff(b'MZ\x90\x00', 'image/svg+xml'))
        self.assertFalse(_sniff(b'\x89PNG\r\n\x1a\n', 'application/pdf'))
        self.assertFalse(_sniff(b'<svg/>', 'image/vnd.adobe.photoshop'))


class DocumentSignatureTests(SimpleTestCase):
    DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

    def test_docx_is_a_zip_and_text_is_utf8_without_nuls(self):
        self.assertTrue(_sniff(b'PK\x03\x04\x14\x00', self.DOCX))
        self.assertFalse(_sniff(b'%PDF-1.7\n', self.DOCX))
        self.assertTrue(_sniff(b'# Brief\nShot list', 'text/markdown'))
        self.assertTrue(_sniff('Hindi: नमस्ते'.encode()[:-1], 'text/plain'))
        self.assertFalse(_sniff(b'\x89PNG\r\n\x1a\n', 'text/plain'))
        self.assertFalse(_sniff(b'text\x00with nul', 'text/markdown'))
        self.assertFalse(_sniff(b'', 'text/plain'))
