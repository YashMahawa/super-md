import subprocess
import unittest
from unittest.mock import patch
from package import create_dmg

class DmgTest(unittest.TestCase):
    def test_only_busy_failures_are_retried_and_success_is_required(self):
        busy=subprocess.CompletedProcess([],1,"","hdiutil: create failed - Resource busy")
        success=subprocess.CompletedProcess([],0,"created: /tmp/test.dmg","")
        with patch('package.subprocess.run',side_effect=[busy,success]) as run,patch('package.time.sleep') as pause:
            create_dmg('/tmp/test-stage','/tmp/test.dmg')
            self.assertEqual(run.call_count,2);pause.assert_called_once_with(2)
        with patch('package.subprocess.run',return_value=busy) as run,patch('package.time.sleep'):
            with self.assertRaises(subprocess.CalledProcessError):create_dmg('/tmp/test-stage','/tmp/test.dmg')
            self.assertEqual(run.call_count,3)
        with patch('package.subprocess.run',return_value=subprocess.CompletedProcess([],1,"","invalid format")) as run,patch('package.time.sleep') as pause:
            with self.assertRaises(subprocess.CalledProcessError):create_dmg('/tmp/test-stage','/tmp/test.dmg')
            self.assertEqual(run.call_count,1);pause.assert_not_called()
