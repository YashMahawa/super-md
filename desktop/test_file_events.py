import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from file_events import identity,reconcile

class FileEventsTest(unittest.TestCase):
    def test_case_only_rename_is_detected_when_the_old_spelling_still_resolves(self):
        with tempfile.TemporaryDirectory() as directory:
            original=Path(directory)/"study.md";original.write_text("# Note")
            known={str(original):identity(original)}
            renamed=original.with_name("Study.md");original.rename(renamed)
            stat=Path.stat
            def case_insensitive(path,*args,**kwargs):
                return stat(renamed if path==original else path,*args,**kwargs)
            with patch.object(Path,"stat",case_insensitive):
                self.assertEqual(reconcile(known,{directory}),{str(original):str(renamed)})
    def test_same_directory_rename_is_found_by_identity_without_scanning_elsewhere(self):
        with tempfile.TemporaryDirectory() as directory:
            original=Path(directory)/"old.md";original.write_text("# Note")
            known={str(original):identity(original)}
            renamed=original.with_name("new name.md");original.rename(renamed)
            self.assertEqual(reconcile(known,{directory}),{str(original):str(renamed)})
    def test_deleted_files_are_removed_but_atomic_replacements_are_not(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/"note.md";file.write_text("# Original")
            known={str(file):identity(file)}
            staged=file.with_suffix(".tmp");staged.write_text("# New");staged.replace(file)
            self.assertEqual(reconcile(known,{directory}),{})
            file.unlink();self.assertEqual(reconcile(known,{directory}),{str(file):None})
    def test_unrelated_notifications_do_not_scan_or_remove_files(self):
        self.assertEqual(reconcile({"/not/watched/note.md":(1,2)},{"/somewhere/else"}),{})
