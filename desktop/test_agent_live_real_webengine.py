"""Real QML/WebEngine viewport and live CLI integration in an isolated process."""
from __future__ import annotations
import json, os, subprocess, sys, tempfile, unittest, time
from pathlib import Path

ROOT=Path(__file__).resolve().parent

def _probe(directory: str) -> int:
    os.environ["QT_QPA_PLATFORM"]="offscreen"
    os.environ["QT_QUICK_BACKEND"]="software"
    os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS","--disable-gpu --disable-dev-shm-usage")
    os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX","1")
    from PySide6.QtCore import QFile, QIODevice, QUrl, QTimer, QObject, QMetaObject, Q_ARG, Qt
    from PySide6.QtGui import QGuiApplication, QImage
    from PySide6.QtQml import QQmlApplicationEngine
    from PySide6.QtQuickControls2 import QQuickStyle
    from PySide6.QtWidgets import QApplication
    from PySide6.QtWebEngineQuick import QtWebEngineQuick
    QQuickStyle.setStyle("Material")
    QtWebEngineQuick.initialize()
    app=QApplication(["Super MD real live viewport test"])
    from agent_live import create_qt_bridge
    from studio import Session, Studio
    temp=Path(directory); temp.mkdir(parents=True,exist_ok=True)
    session=Session(True); session.settings["newNoteLocation"]=str(temp)
    studio=Studio(True,session); session.agent_bridge=create_qt_bridge(session,session.data); bridge=session.agent_bridge
    tab=studio._current(); tab["name"]="Live capture proof.md"; tab["content"]="# Live capture proof\n\nBefore patch: visible native pixels.\n\n- Reader viewport\n"; tab["saved"]=tab["content"]
    first_native_id=tab["id"]
    second=studio._note("Second.md", "# Second tab\n\nSecond original text.\n", saved="# Second tab\n\nSecond original text.\n")
    studio.tabs.append(second)
    studio.mode="live"; studio.settings["readingMode"]="live"; studio.settings["welcomed"]=True
    channel=QFile(":/qtwebchannel/qwebchannel.js")
    if not channel.open(QIODevice.OpenModeFlag.ReadOnly): raise RuntimeError("Qt WebChannel runtime unavailable")
    channel_script=bytes(channel.readAll()).decode()
    engine=QQmlApplicationEngine()
    engine.rootContext().setContextProperty("studio",studio)
    engine.rootContext().setContextProperty("readerUrl",QUrl.fromLocalFile(str(ROOT.parent/"dist"/"qt-reader.html")))
    engine.rootContext().setContextProperty("channelScript",channel_script)
    engine.rootContext().setContextProperty("brandUrl",QUrl.fromLocalFile(str(ROOT.parent/"public"/"brand-mark-fixed.svg")))
    engine.load(QUrl.fromLocalFile(str(ROOT/"qml"/"Main.qml")))
    if not engine.rootObjects():
        session.agent_bridge.stop(); studio.stop(); studio.pool.shutdown(wait=False,cancel_futures=True); session.writes.shutdown(wait=False)
        raise RuntimeError("Production Main.qml did not load; see the QML diagnostic above")
    window=engine.rootObjects()[0]; studio.host_window=window; window.show()
    studio._emit()
    bridge.start()
    cli=ROOT/"agent_cli.py"; sessions=str(bridge.discovery_dir); state={"proc":None,"results":{},"failure":"",
        "first_native_id":first_native_id,"second_native_id":second["id"]}
    sequence=[]
    def start_call(key,*arguments):
        command=[sys.executable,str(cli),"live","--sessions-dir",sessions,*map(str,arguments)]
        process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                                 env=dict(os.environ,QT_QPA_PLATFORM="invalid"))
        state["proc"]=process; state["key"]=key; state["stage"]=key
        QTimer.singleShot(5,poll)
    def begin_cli_after_pending_typing():
        state["stage"]="open textarea and type pending draft"
        reader=window.findChild(QObject,"documentReader")
        if reader is None:
            state["failure"]="Production WebEngine reader object was not found"; finish(2); return
        script="""(()=>{const deadline=Date.now()+10000;
          const typeWhenReady=()=>{const area=document.querySelector('.live-active-block textarea');
            if(!area){if(Date.now()<deadline){setTimeout(typeWhenReady,50);return;}
              window.__agentTypingFailure='live editor did not open';document.title='supermd-agent-typing-error:live editor did not open';return;}
            area.focus();area.setSelectionRange(area.value.length,area.value.length);
            const inserted=document.execCommand('insertText',false,'\\nPending human draft');
            if(!inserted){window.__agentTypingFailure='browser could not insert the pending draft';document.title='supermd-agent-typing-error:browser could not insert the pending draft';return;}
            // execCommand produces the browser's real textarea input event,
            // which React handles as a user edit. Wait for its controlled value
            // to settle while keeping focus in the editor: the subsequent CLI
            // activation must flush an unblurred human draft.
            const expected='Pending human draft';
            const confirm=()=>{const current=document.querySelector('.live-active-block textarea');
              if(current?.value.endsWith(expected)&&document.activeElement===current){window.__agentTypingReady=true;document.title='supermd-agent-typing-ready';return;}
              if(Date.now()<deadline){setTimeout(confirm,25);return;}
              window.__agentTypingFailure='textarea did not retain the focused pending draft after input';document.title='supermd-agent-typing-error:textarea did not retain the focused pending draft after input';};
            setTimeout(confirm,25);};
          // The native bridge can become ready before React has committed the
          // document. Wait for the actual editable block before double-clicking.
          const openWhenReady=()=>{const block=document.querySelector('.live-block');
            if(!block){if(Date.now()<deadline){setTimeout(openWhenReady,25);return;}
              document.title='supermd-agent-typing-error:no editable block';return;}
            block.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));typeWhenReady();};
          openWhenReady();return 'scheduled';})()"""
        if not QMetaObject.invokeMethod(window,"runDocumentScript",Qt.ConnectionType.DirectConnection,Q_ARG("QVariant",script)):
            state["failure"]="Could not schedule the real reader DOM edit"; finish(2); return
        # Run through the production QML helper: PySide's QQuickWebEngineView
        # wrapper exposes only its callback overload, while QML supports the
        # fire-and-forget form used by the app.
        # Bridge the in-page DOM readiness check through the WebEngine title
        # property. This avoids PySide's platform-dependent runJavaScript
        # callback overload and starts activation as soon as the focused,
        # controlled textarea has accepted the input.
        def wait_for_pending_edit():
            title=reader.property("title")
            if title=="supermd-agent-typing-ready":
                start_call("list_initial","list"); return
            if isinstance(title,str) and title.startswith("supermd-agent-typing-error:"):
                state["failure"]=title.partition(":")[2]; finish(2); return
            if time.monotonic()>typing_deadline:
                state["failure"]=f"Timed out waiting for focused pending draft input; reader title={title!r}"; finish(2); return
            QTimer.singleShot(50,wait_for_pending_edit)
        typing_deadline=time.monotonic()+12
        QTimer.singleShot(50,wait_for_pending_edit)
    def parse_output(process,key):
        stdout,stderr=process.communicate()
        if process.returncode!=0:
            raise RuntimeError(f"CLI {key} failed: {stdout.strip()} {stderr.strip()}")
        try: return json.loads(stdout)["result"]
        except Exception as error: raise RuntimeError(f"CLI {key} returned invalid JSON: {stdout!r}") from error
    def start_next():
        if not sequence:
            raise RuntimeError("Real CLI integration sequence ended before completion")
        key,builder=sequence.pop(0)
        start_call(key,*builder(state.get("row",{})))
    def start_jpeg_capture():
        from agent_live import LiveTabClient
        state["jpeg_done"]=False
        def capture():
            try:
                state["jpeg_result"]=LiveTabClient(bridge.discovery_path).render_tab(
                    state["second_native_id"],width=640,window_id=studio.window_id,image_format="jpeg")
            except Exception as error:
                state["jpeg_error"]=str(error)
            state["jpeg_done"]=True
        import threading
        state["jpeg_thread"]=threading.Thread(target=capture,daemon=True)
        state["jpeg_thread"].start()
        QTimer.singleShot(10,poll_jpeg_capture)
    def poll_jpeg_capture():
        if not state.get("jpeg_done"):
            QTimer.singleShot(10,poll_jpeg_capture); return
        try:
            if state.get("jpeg_error"):
                raise RuntimeError(f"JPEG viewport request failed: {state['jpeg_error']}")
            result=state["jpeg_result"]
            image=QImage()
            if result.get("mime_type")!="image/jpeg" or not image.loadFromData(result.get("data",b""),"JPEG"):
                raise RuntimeError("Requested JPEG viewport did not decode as JPEG")
            if max(image.width(),image.height())>640 or image.width()<200 or image.height()<100:
                raise RuntimeError(f"JPEG viewport ignored its 640-pixel bound: {image.width()}x{image.height()}")
            colors={image.pixelColor(x,y).rgba() for x in range(0,image.width(),16) for y in range(0,image.height(),16)}
            if len(colors)<2:
                raise RuntimeError("JPEG viewport image contains no visible reader detail")
            state["results"]["jpegImageSize"]=[image.width(),image.height()]
            if studio.active!=state["second_native_id"] or studio.mode!="live":
                raise RuntimeError("JPEG viewport capture changed the active reader view")
            start_next()
        except Exception as error:
            state["failure"]=str(error); finish(2)
    def on_result(key,result):
        state["results"][key]=result
        if key=="list_initial":
            rows=result.get("tabs",[])
            if len(rows)<2: raise RuntimeError("Live CLI did not list both open tabs")
            state["first_id"]=next(row["id"] for row in rows if row["id"].endswith(":"+state["first_native_id"]))
            state["second_id"]=next(row["id"] for row in rows if row["id"].endswith(":"+state["second_native_id"]))
            state["row"]=next(row for row in rows if row["id"]==state["first_id"]); state["tab_id"]=state["first_id"]
            sequence.extend([
                ("read",lambda _row:("read",state["tab_id"],"--view","source")),
                ("context",lambda _row:("context",state["tab_id"])),
                ("activate_second",lambda _row:("activate",state["second_id"])),
            ])
            start_next()
        elif key=="read":
            if "Before patch" not in result.get("markdown",""): raise RuntimeError("Live read did not show current source")
            start_next()
        elif key=="context":
            viewport=result.get("viewport",{})
            if viewport.get("width",0)<=0 or viewport.get("height",0)<=0:
                raise RuntimeError("Live context did not return actual reader viewport bounds")
            start_next()
        elif key=="activate_second":
            if result.get("tabId")!=state["second_native_id"]:
                raise RuntimeError(f"CLI did not activate the requested second tab: {result}")
            state["row"]=result
            sequence.extend([
                ("patch",lambda row:("patch",state["second_id"],"--revision",row["revision"],"--operations-json",
                                     json.dumps([{"type":"replace","old":"Second original","new":"Second patched"}]))),
                ("list_after_patch",lambda _row:("list",)),
            ])
            start_next()
        elif key=="patch":
            if not result.get("changed"): raise RuntimeError("Live patch did not change the note")
            start_next()
        elif key=="list_after_patch":
            row=next(row for row in result["tabs"] if row["id"]==state["second_id"]); state["row"]=row
            sequence.extend([
                ("snapshot",lambda _row:("snapshot",state["second_id"],str(temp/"actual-reader"),"--width","640")),
                ("export",lambda row:("export",state["second_id"],"md","--revision",row["revision"])),
                ("activate_first",lambda _row:("activate",state["first_id"])),
            ])
            start_next()
        elif key=="snapshot":
            image=QImage(result["path"])
            if image.isNull() or image.width()<200 or image.height()<100:
                raise RuntimeError(f"Viewport was not captured from the real app: {image.width()}x{image.height()}")
            if max(image.width(),image.height())>640:
                raise RuntimeError(f"Viewport ignored the requested 640-pixel bound: {image.width()}x{image.height()}")
            colors={image.pixelColor(x,y).rgba() for x in range(0,image.width(),16) for y in range(0,image.height(),16)}
            if len(colors)<2: raise RuntimeError("Viewport image contains no visible reader detail")
            state["results"]["imageSize"]=[image.width(),image.height()]
            start_jpeg_capture()
        elif key=="activate_first":
            if result.get("tabId")!=state["first_native_id"]:
                raise RuntimeError(f"CLI did not reactivate the first tab: {result}")
            sequence.extend([
                ("read_first_draft",lambda _row:("read",state["first_id"],"--view","source")),
            ])
            start_next()
        elif key=="read_first_draft":
            if "Pending human draft" not in result.get("markdown",""):
                raise RuntimeError(f"Switching tabs lost the pending human draft: {result}")
            if not result.get("isDirty",True):
                raise RuntimeError("The pending draft was unexpectedly marked clean after tab activation")
            undo_script="window.supermdHistory('undo')"
            if not QMetaObject.invokeMethod(window,"runDocumentScript",Qt.ConnectionType.DirectConnection,Q_ARG("QVariant",undo_script)):
                raise RuntimeError("Could not invoke reader undo after reactivating the edited tab")
            QTimer.singleShot(350,lambda: start_call("read_after_undo","read",state["first_id"],"--view","source"))
        elif key=="read_after_undo":
            if "Pending human draft" in result.get("markdown","") or "Before patch" not in result.get("markdown",""):
                raise RuntimeError("The first tab's undo history was not preserved across activation")
            finish()
        elif key=="export":
            state["job_id"]=result["jobId"]
            sequence.insert(0,("job",lambda _row:("job",state["job_id"])))
            start_next()
        elif key=="job":
            if result.get("status")=="completed":
                state["results"]["export_path"]=result.get("path","")
                start_next()
            elif result.get("status") in ("failed","cancelled"):
                raise RuntimeError(f"Native export job did not complete: {result}")
            else:
                sequence.insert(0,("job",lambda _row:("job",state["job_id"])))
                QTimer.singleShot(100,start_next)
    def poll():
        process=state["proc"]
        if process is None: return
        if process.poll() is None:
            QTimer.singleShot(20,poll); return
        key=state["key"]
        try: on_result(key,parse_output(process,key))
        except Exception as error:
            state["failure"]=str(error); finish(2)
    def finish(code=0):
        if state.get("done"): return
        state["done"]=True
        try: bridge.stop()
        except Exception: pass
        try: window.close()
        except Exception: pass
        try: studio.stop()
        except Exception: pass
        try: studio.pool.shutdown(wait=False,cancel_futures=True)
        except Exception: pass
        try: session.writes.shutdown(wait=False)
        except Exception: pass
        if code==0:
            print(json.dumps({"ok":True,"steps":list(state["results"]),"imageSize":state["results"].get("imageSize"),
                              "jpegImageSize":state["results"].get("jpegImageSize"),
                              "exportPath":state["results"].get("export_path")},separators=(",",":")))
        else:
            print(json.dumps({"ok":False,"error":state["failure"]},separators=(",",":")))
        app.exit(code)
    def wait_ready():
        if studio.ready:
            begin_cli_after_pending_typing(); return
        if time.monotonic()>deadline:
            reader=window.findChild(QObject,"documentReader")
            state["failure"]=("Real Qt WebEngine reader did not report ready: "
                              f"studio.ready={studio.ready} viewReady={window.property('readerReady')} "
                              f"url={reader.property('url') if reader else None} loading={reader.property('loading') if reader else None} "
                              f"progress={reader.property('loadProgress') if reader else None}")
            finish(2); return
        QTimer.singleShot(50,wait_ready)
    deadline=time.monotonic()+25
    QTimer.singleShot(50,wait_ready)
    QTimer.singleShot(75_000,lambda: (state.update(failure=f"Real viewport CLI flow timed out at {state.get('stage')}"),finish(2)))
    code=app.exec()
    return code

class RealWebEngineAgentRenderTests(unittest.TestCase):
    @unittest.skipUnless((ROOT.parent/"dist"/"qt-reader.html").is_file(),"Build the Qt reader before real WebEngine integration tests")
    def test_real_studio_qml_browser_hook_and_cli_capture_current_reader_pixels(self):
        with tempfile.TemporaryDirectory(prefix="supermd-real-agent-render-") as temp:
            env=dict(os.environ,QT_QPA_PLATFORM="offscreen",QT_QUICK_BACKEND="software",
                     QT_SCALE_FACTOR="2",
                     QTWEBENGINE_DISABLE_SANDBOX="1",QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu --disable-dev-shm-usage")
            result=subprocess.run([sys.executable,str(Path(__file__).resolve()),"--probe",temp],cwd=ROOT,env=env,
                                  capture_output=True,text=True,timeout=90)
        lines=[line for line in result.stdout.splitlines() if line.startswith("{" )]
        self.assertTrue(lines,f"real QML/WebEngine probe emitted no report: {result.stdout}\n{result.stderr}")
        report=json.loads(lines[-1])
        self.assertEqual(result.returncode,0,f"real app probe failed: {report}\n{result.stderr}")
        self.assertTrue(report["ok"],report)
        self.assertIn("read",report["steps"]); self.assertIn("patch",report["steps"])
        self.assertIn("context",report["steps"])
        self.assertIn("snapshot",report["steps"]); self.assertIn("export",report["steps"])
        self.assertIn("activate_second",report["steps"]); self.assertIn("read_first_draft",report["steps"])
        self.assertIn("read_after_undo",report["steps"])
        self.assertGreaterEqual(report["imageSize"][0],200)
        self.assertLessEqual(max(report["imageSize"]),640)

if __name__=="__main__" and len(sys.argv)>1 and sys.argv[1]=="--probe":
    raise SystemExit(_probe(sys.argv[2]))
