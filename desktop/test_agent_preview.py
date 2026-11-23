"""Exercise the real offline reader through the headless CLI, not an HTML clone."""
import hashlib,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
class PreviewTests(unittest.TestCase):
    def test_real_reader_preview_preserves_source_and_renders_vector_pixels(self):
        root=Path(__file__).resolve().parent.parent
        if not (root/'dist/qt-reader.html').is_file():self.skipTest('Build the offline reader first')
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);note=folder/'note.md';output=folder/'preview.png'
            note.write_text('# Preview proof\n\n> [!question] Q1.\n> Find $x+1$.\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect x="20" y="20" width="360" height="160" fill="#1688dd"/></svg>\n```\n',encoding='utf-8')
            original=note.read_bytes()
            result=subprocess.run([sys.executable,str(root/'desktop/agent_cli.py'),'--root',directory,'preview',str(note),str(output),'--width','800','--height','700','--heading','Preview proof'],capture_output=True,text=True,timeout=55,env={**os.environ,'QT_QPA_PLATFORM':'offscreen'})
            self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr[-1500:])
            self.assertEqual(note.read_bytes(),original)
            from PySide6.QtGui import QImage
            image=QImage(str(output));self.assertEqual((image.width(),image.height()),(800,700))
            blues=sum(image.pixelColor(x,y).blue()>150 and image.pixelColor(x,y).red()<80 for y in range(0,700,8) for x in range(0,800,8))
            self.assertGreater(blues,200,'The reader capture must include actual blue SVG pixels, not a blank page')
            self.assertTrue(json.loads(result.stdout)['result']['sourceUnchanged'])
