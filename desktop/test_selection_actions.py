import json
import os
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from PySide6.QtGui import QGuiApplication
from selection_actions import selection_target, HOMES
from test_studio import QuietStudio


class SelectionActionsTest(unittest.TestCase):
    def test_search_preserves_unicode_newlines_and_url_punctuation(self):
        text='A & B? # \u03a9 + 100%\u2029next line'
        url, copy, _=selection_target('google',text)
        self.assertEqual(urlsplit(url).netloc,'www.google.com')
        self.assertEqual(parse_qs(urlsplit(url).query)['q'],[text.replace('\u2029','\n')])
        self.assertFalse(copy)

    def test_default_and_unverified_providers_copy_instead_of_auto_submitting(self):
        for provider, home in HOMES.items():
            with self.subTest(provider=provider):
                self.assertEqual(selection_target('assistant','Do not send this yet',provider)[:2],(home,True))
        self.assertTrue(selection_target('assistant','x'*9000,'claude')[1])

    def test_invalid_and_oversized_inputs_are_rejected_without_truncation(self):
        for args in [('google',''),('google','x'*9000),('assistant','x'*1_000_001),('unknown','text'),('assistant','text','https://evil.test'),('assistant','text',[])]:
            with self.subTest(args=str(args)[:80]),self.assertRaises(ValueError):selection_target(*args)

    @classmethod
    def setUpClass(cls):
        cls.app=QGuiApplication.instance() or QGuiApplication(['Selection actions'])

    def test_native_action_uses_snapshot_text_and_never_reloads_the_note(self):
        studio=QuietStudio(True)
        try:
            before=studio._current()['content'];calls=[]
            studio.readerCall.connect(lambda *args:calls.append(args))
            with patch('studio.QDesktopServices.openUrl',return_value=True) as open_url:
                studio.selectionAction('assistant','    \u03a9 & selected\u2029    text\n')
                self.assertEqual(QGuiApplication.clipboard().text(),'    \u03a9 & selected\n    text\n')
                self.assertEqual(open_url.call_args.args[0].toString(),HOMES['chatgpt'])
                studio.setting('selectionAssistant',json.dumps('gemini'))
                self.assertEqual(studio.selectionAssistantLabel,'Gemini')
                studio.selectionAction('assistant','another selection')
                self.assertEqual(open_url.call_args.args[0].toString(),HOMES['gemini'])
                studio.setting('selectionAssistant',json.dumps('bad'))
                self.assertEqual(studio.selectionAssistantLabel,'Gemini')
                studio.selectionAction('google','hello & world')
                self.assertEqual(parse_qs(urlsplit(open_url.call_args.args[0].toString()).query)['q'],['hello & world'])
                previous=open_url.call_count
                studio.selectionAction('google','')
                self.assertEqual(open_url.call_count,previous)
            self.assertEqual(studio._current()['content'],before)
            self.assertFalse(calls,'Selection actions must not reload or edit the document')
        finally:
            studio.stop();studio.pool.shutdown(wait=True);studio.session.writes.shutdown(wait=True)


if __name__=='__main__':unittest.main()
