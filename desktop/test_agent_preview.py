"""Exercise the real offline reader through the headless CLI, not an HTML clone."""
import json,os,subprocess,sys,tempfile,unittest
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

    def test_headless_preview_renders_sandboxed_mermaid_with_file_urls_disabled(self):
        root=Path(__file__).resolve().parent.parent
        if not (root/'dist/qt-reader.html').is_file():self.skipTest('Build the offline reader first')
        preview_src=(root/'desktop/agent_preview.py').read_text(encoding='utf-8')
        self.assertIn('LocalContentCanAccessFileUrls,False',preview_src.replace(' ',''))
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory);note=folder/'mermaid-note.md';output=folder/'mermaid-preview.png'
            note.write_text('# Isolated diagram\n\n```mermaid\ngantt\n  title Study schedule\n  Task A :a1, 2026-09-01, 3d\n```\n',encoding='utf-8')
            result=subprocess.run([sys.executable,str(root/'desktop/agent_cli.py'),'--root',directory,'preview',str(note),str(output),'--width','800','--height','600'],capture_output=True,text=True,timeout=55,env={**os.environ,'QT_QPA_PLATFORM':'offscreen','QTWEBENGINE_DISABLE_SANDBOX':'1'})
            self.assertEqual(result.returncode,0,result.stdout+'\n'+result.stderr[-1500:])
            from PySide6.QtGui import QImage
            image=QImage(str(output))
            self.assertEqual((image.width(),image.height()),(800,600))

    def test_offline_view_wrappers_preserve_real_png_artifacts_and_structured_errors(self):
        root=Path(__file__).resolve().parent.parent
        if not (root/'dist/qt-reader.html').is_file():self.skipTest('Build the offline reader first')
        sys.path.insert(0,str(root/'desktop'))
        from agent_documents import DocumentStore
        import offline_view
        from PySide6.QtGui import QImage
        previous=os.environ.get('QTWEBENGINE_DISABLE_SANDBOX')
        os.environ['QTWEBENGINE_DISABLE_SANDBOX']='1'
        try:
            with tempfile.TemporaryDirectory() as directory:
                folder=Path(directory);note=folder/'offline.md'
                note.write_text('# Real offline wrapper\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"><rect x="10" y="10" width="280" height="130" fill="#1688dd"/></svg>\n```\n',encoding='utf-8')
                store=DocumentStore([directory])
                png=offline_view.render_offline(store,str(note),width=720)
                image=QImage.fromData(png,'PNG')
                self.assertEqual(image.width(),720)
                live_png=offline_view.render_live_snapshot('# Live snapshot\n\nParagraph text.\n',{},str(note),width=640)
                live_image=QImage.fromData(live_png,'PNG')
                self.assertEqual(live_image.width(),640)
                with self.assertRaisesRegex(ValueError,'Background preview failed: .*Missing heading'):
                    offline_view.render_live_snapshot('# Live snapshot\n',{},str(note),width=640,heading='Missing heading')
        finally:
            if previous is None:os.environ.pop('QTWEBENGINE_DISABLE_SANDBOX',None)
            else:os.environ['QTWEBENGINE_DISABLE_SANDBOX']=previous
