"""Real QML/WebEngine viewport and live CLI integration in an isolated process."""
from __future__ import annotations
import json, os, queue, subprocess, sys, tempfile, threading, unittest, time
from pathlib import Path

ROOT=Path(__file__).resolve().parent

def _drain_process_output(process):
    """Start draining both child pipes before the child can fill either one."""
    completed = queue.Queue(maxsize=1)
    def collect():
        try:
            stdout, stderr = process.communicate()
            completed.put(((process.returncode, stdout, stderr), None))
        except BaseException as error:
            completed.put((None, error))
    thread = threading.Thread(target=collect, name="supermd-cli-output", daemon=True)
    thread.start()
    return completed, thread


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
    svg_body="<svg xmlns=\"http://www.w3.org/2000/svg\">\n"+"\n".join(f"<path id=\"svg-{index}\" d=\"M0 {index}L10 {index}\"/>" for index in range(2200))+"\n</svg>"
    mermaid='graph TD; A["Σ 😀"]-->B'
    prose_after="After the drawing, ordinary prose remains readable.\n"*900
    first_content=("# Live capture proof 🧭\n\nBefore patch: visible native pixels.\n\n- Reader viewport\n\n"+
                   "```mermaid\n"+mermaid+"\n```\n\n```svg\n"+svg_body+"\n```\n\n"+prose_after)
    tab=studio._current(); tab["name"]="Live capture proof.md"; tab["content"]=first_content; tab["saved"]=first_content
    first_native_id=tab["id"]
    second=studio._note("Second.md", "# Second tab\n\nSecond untouched text.\n", saved="# Second tab\n\nSecond untouched text.\n")
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
        "first_native_id":first_native_id,"second_native_id":second["id"],"first_content":first_content,
        "save_path":str(temp/"existing-note.md"),"save_as_path":str(temp/"existing-note-copy.md")}
    Path(state["save_path"]).write_text("# Saved note\n\nOriginal persisted text.\n",encoding="utf-8")
    sequence=[]
    def start_call(key,*arguments,expect_error=False):
        command=[sys.executable,str(cli),"live","--sessions-dir",sessions,*map(str,arguments)]
        process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                                 encoding="utf-8",errors="strict",
                                 env=dict(os.environ,QT_QPA_PLATFORM="invalid"))
        capture, drain_thread = _drain_process_output(process)
        state["proc"]=process; state["capture"]=capture; state["drain_thread"]=drain_thread
        state["key"]=key; state["stage"]=key; state["expect_error"]=expect_error
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
    def parse_output(process,key,returncode,stdout,stderr):
        if returncode!=0:
            if state.get("expect_error"):
                try:
                    report=json.loads(stdout)
                    if report.get("ok") is False and isinstance(report.get("error"),dict):
                        return {"expectedError":report["error"].get("message","")}
                except Exception: pass
            context=(f" target={state.get('saved_target')!r} openJob={state.get('results',{}).get('open_job')!r} "
                     f"tabs={[(tab['id'],tab.get('path')) for tab in studio.tabs]!r}" if key=="patch_saved_note" else "")
            raise RuntimeError(f"CLI {key} failed:{context} {stdout.strip()} {stderr.strip()}")
        try: return json.loads(stdout)["result"]
        except Exception as error: raise RuntimeError(f"CLI {key} returned invalid JSON: {stdout!r}") from error
    def start_next():
        if not sequence:
            raise RuntimeError("Real CLI integration sequence ended before completion")
        item=sequence.pop(0);key,builder=item[:2];expect_error=bool(item[2]) if len(item)>2 else False
        start_call(key,*builder(state.get("row",{})),expect_error=expect_error)
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
            second_row=next(row for row in rows if row["id"]==state["second_id"])
            state["second_revision_before_inactive_patch"]=second_row["revision"]
            sequence.extend([
                ("read",lambda _row:("read",state["tab_id"],"--view","source")),
                ("context",lambda _row:("context",state["tab_id"])),
                ("prose_read",lambda _row:("read",state["first_id"],"--view","prose")),
                ("patch_second_inactive",lambda _row:("patch",state["second_id"],"--revision",state["second_revision_before_inactive_patch"],"--operations-json",
                                    json.dumps([{"type":"replace","old":"Second untouched","new":"Second inactive"}]))),
            ])
            start_next()
        elif key=="read":
            if "Before patch" not in result.get("markdown",""): raise RuntimeError("Live read did not show current source")
            start_next()
        elif key=="prose_read":
            text=result.get("markdown",""); omitted=result.get("svg_omissions",[])
            svg_end=len(state["first_content"][:state["first_content"].index("\n```\n\n"+prose_after)])
            if not omitted or "[SVG omitted:" not in text or "After the drawing" not in text:
                raise RuntimeError("Production prose read did not elide the SVG and continue into following prose")
            if result.get("end",0)<=svg_end or result.get("returned_chars")!=len(text):
                raise RuntimeError(f"Prose pagination did not jump over the SVG with exact returned_chars: {result}")
            state["results"]["prose_svg_jump"]={"end":result.get("end"),"omittedChars":omitted[0].get("omitted_chars"),"returnedChars":result.get("returned_chars")}
            start_next()
        elif key=="patch_second_inactive":
            if not result.get("changed") or result.get("applied")!=1:
                raise RuntimeError(f"Inactive patch did not apply once: {result}")
            if studio.active!=state["first_native_id"]:
                raise RuntimeError("Patching an inactive tab changed the focused tab")
            state["second_revision_after_inactive_patch"]=result["revision"]
            if result["revision"]==state["second_revision_before_inactive_patch"]:
                raise RuntimeError("Inactive patch did not advance the target revision")
            sequence.append(("activate_second",lambda _row:("activate",state["second_id"])))
            start_next()
        elif key=="context":
            viewport=result.get("viewport",{})
            if viewport.get("width",0)<=0 or viewport.get("height",0)<=0:
                raise RuntimeError("Live context did not return actual reader viewport bounds")
            start_next()
        elif key=="activate_second":
            if result.get("tabId")!=state["second_native_id"]:
                raise RuntimeError(f"CLI did not activate the requested second tab: {result}")
            if result.get("revision")!=state["second_revision_after_inactive_patch"]:
                raise RuntimeError("Activating the second tab did not retain the inactive patch revision")
            state["row"]=result
            sequence.extend([
                ("diagrams_inactive",lambda _row:("diagrams",state["first_id"])),
            ])
            start_next()
        elif key=="diagrams_inactive":
            diagrams=result.get("diagrams",[])
            if len(diagrams)!=2 or result.get("total")!=2:
                raise RuntimeError(f"Inactive diagram inventory was incomplete: {result}")
            current_first=next(tab for tab in studio.tabs if tab["id"]==state["first_native_id"])
            mermaid_fence_start=current_first["content"].index("```mermaid")
            expected_start=len(current_first["content"][:mermaid_fence_start])
            first_diagram=diagrams[0]
            if first_diagram.get("sourceStart")!=expected_start or first_diagram.get("id")!=f"diagram:{expected_start}":
                raise RuntimeError(f"Diagram ID/sourceStart mismatch: expected Mermaid fence at code-point offset {expected_start}; got {first_diagram}")
            if studio.active!=state["second_native_id"]:
                raise RuntimeError("Inactive diagram inventory changed focus")
            state["diagram_revision"]=result["revision"];state["diagram_id"]=first_diagram["id"]
            sequence.append(("diagram_source_inactive",lambda _row:("diagram",state["first_id"],state["diagram_id"],"--revision",state["diagram_revision"])))
            start_next()
        elif key=="diagram_source_inactive":
            if result.get("text")!=mermaid:
                raise RuntimeError(f"Inactive source hook did not return the exact diagram text: {result}")
            if studio.active!=state["second_native_id"]:
                raise RuntimeError("Reading inactive diagram source changed focus")
            state["results"]["inactive_diagram"]={"id":state["diagram_id"],"sourceStart":result.get("sourceStart"),"text":result.get("text")}
            row=state["row"]
            sequence.extend([
                ("patch",lambda _row:("patch",state["second_id"],"--revision",state["second_revision_after_inactive_patch"],"--operations-json",
                                     json.dumps([{"type":"replace","old":"Second inactive","new":"Second patched"}]))),
                ("list_after_patch",lambda _row:("list",)),
            ])
            start_next()
        elif key=="patch":
            if not result.get("changed"): raise RuntimeError("Live patch did not change the note")
            if studio.active!=state["second_native_id"]: raise RuntimeError("Patching second tab changed focus unexpectedly")
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
            if "Pending human draft" not in result.get("markdown","") or "Before patch" not in result.get("markdown",""):
                raise RuntimeError(f"Switching tabs lost the pending human draft or altered the first tab: {result}")
            if not result.get("isDirty",True):
                raise RuntimeError("The pending draft was unexpectedly marked clean after tab activation")
            undo_script="window.supermdHistory('undo')"
            if not QMetaObject.invokeMethod(window,"runDocumentScript",Qt.ConnectionType.DirectConnection,Q_ARG("QVariant",undo_script)):
                raise RuntimeError("Could not invoke reader undo after reactivating the edited tab")
            QTimer.singleShot(350,lambda: start_call("read_after_undo","read",state["first_id"],"--view","source"))
        elif key=="read_after_undo":
            if "Pending human draft" in result.get("markdown","") or "Before patch" not in result.get("markdown",""):
                raise RuntimeError("The first tab's undo history was not preserved across activation")
            # Continue with the document lifecycle checks after the real editor
            # has acknowledged its undo and the pending draft is gone.
            sequence.append(("create_background",lambda _row:("create","--content-file",str(temp/"background.md"),"--filename","Background.md","--background")))
            (temp/"background.md").write_text("# Background\n\nUnsaved background tab.\n",encoding="utf-8")
            start_next()
        elif key=="create_background":
            if result.get("active") is not False or studio.active!=state["first_native_id"]:
                raise RuntimeError(f"Background create stole focus: {result}")
            state["created_target"]=result.get("target")
            state["created_revision"]=result.get("revision")
            sequence.extend([
                ("activate_created",lambda _row:("activate",state["created_target"])),
            ])
            start_next()
        elif key=="activate_created":
            if result.get("active") is not True or studio.active!=result.get("tabId"):
                raise RuntimeError(f"Explicit activation did not focus the created tab: {result}")
            state["created_revision"]=result["revision"]
            sequence.append(("close_dirty_created",lambda _row:("close",state["created_target"],"--revision",state["created_revision"]),True))
            start_next()
        elif key=="close_dirty_created":
            if "unsaved changes" not in result.get("expectedError",""):
                raise RuntimeError(f"Dirty close was not safely refused: {result}")
            sequence.append(("close_created",lambda _row:("close",state["created_target"],"--revision",state["created_revision"],"--discard-changes")))
            start_next()
        elif key=="close_created":
            if result.get("status") not in ("closed","closing"):
                raise RuntimeError(f"Explicit discard did not close created tab: {result}")
            sequence.append(("confirm_created_closed",lambda _row:("list",)))
            start_next()
        elif key=="confirm_created_closed":
            still_open=any(row.get("id")==state["created_target"] for row in result.get("tabs",[]))
            if still_open:
                sequence.insert(0,("confirm_created_closed",lambda _row:("list",)))
                QTimer.singleShot(100,start_next)
                return
            # A close can report "closing" while closed-note recovery is still
            # being written. Capture focus only after a fresh CLI listing proves
            # that the target tab has actually left the live session.
            state["focus_before_background_open"]=studio.active
            sequence.append(("open_background",lambda _row:("open",state["save_path"],"--background")))
            start_next()
        elif key=="open_background":
            if result.get("status")!="opening" or not result.get("jobId"):
                raise RuntimeError(f"Background open did not return an async job: {result}")
            if studio.active!=state["focus_before_background_open"]:
                raise RuntimeError("Background open changed focus before completion")
            state["open_job"]=result["jobId"]
            sequence.insert(0,("open_job",lambda _row:("job",state["open_job"])))
            QTimer.singleShot(100,start_next)
        elif key=="open_job":
            if result.get("status")=="completed":
                if result.get("active") is not False or studio.active!=state["focus_before_background_open"]:
                    raise RuntimeError(f"Background-opened note changed focus: {result}")
                state["saved_native_id"]=result.get("tabId")
                state["saved_revision"]=result.get("revision")
                state["saved_path"]=result.get("path")
                if Path(state["saved_path"]).resolve()!=Path(state["save_path"]).resolve():
                    raise RuntimeError(f"Opening did not bind the requested path: {result}")
                sequence.append(("list_opened",lambda _row:("list",)))
                start_next()
            elif result.get("status") in ("failed","cancelled"):
                raise RuntimeError(f"Background open job failed: {result}")
            else:
                sequence.insert(0,("open_job",lambda _row:("job",state["open_job"])))
                QTimer.singleShot(100,start_next)
        elif key=="list_opened":
            opened=next((row for row in result.get("tabs",[]) if row["id"].endswith(":"+state["saved_native_id"])),None)
            if opened is None or Path(opened.get("path","")).resolve()!=Path(state["save_path"]).resolve():
                raise RuntimeError(f"Completed open job was not visible in a fresh session listing: {result}")
            state["saved_target"]=opened["id"]
            if opened["revision"]!=state["saved_revision"]:
                raise RuntimeError("Fresh session listing disagreed with the completed open job revision")
            sequence.append(("patch_saved_note",lambda _row:("patch",state["saved_target"],"--revision",state["saved_revision"],"--operations-json",
                                 json.dumps([{"type":"replace","old":"Original persisted text","new":"Updated persisted text"}]))))
            start_next()
        elif key=="patch_saved_note":
            if not result.get("changed") or studio.active!=state["focus_before_background_open"]:
                raise RuntimeError(f"Inactive file patch changed focus or failed: result={result}; target={state.get('saved_target')!r}; open_job={state.get('results',{}).get('open_job')!r}; tabs={[(tab['id'],tab.get('path')) for tab in studio.tabs]!r}")
            state["saved_revision"]=result["revision"]
            sequence.append(("save_in_place",lambda _row:("save",state["saved_target"],"--revision",state["saved_revision"])))
            start_next()
        elif key=="save_in_place":
            if result.get("pathChanged") or Path(result.get("path","")).resolve()!=Path(state["save_path"]).resolve():
                raise RuntimeError(f"Default save changed the existing path: {result}")
            saved_text=Path(state["save_path"]).read_text(encoding="utf-8")
            if saved_text!="# Saved note\n\nUpdated persisted text.\n":
                raise RuntimeError(f"In-place save did not overwrite the existing file: {saved_text!r}")
            state["saved_revision"]=result["revision"]
            sequence.append(("save_as",lambda _row:("save",state["saved_target"],"--revision",state["saved_revision"],"--filename",Path(state["save_as_path"]).name,"--save-as")))
            start_next()
        elif key=="save_as":
            if not result.get("pathChanged") or Path(result.get("path","")).resolve()!=Path(state["save_as_path"]).resolve():
                raise RuntimeError(f"Explicit save-as did not return its new path: {result}")
            if Path(state["save_path"]).read_text(encoding="utf-8")!="# Saved note\n\nUpdated persisted text.\n":
                raise RuntimeError("Save-as changed the existing source file")
            if Path(state["save_as_path"]).read_text(encoding="utf-8")!="# Saved note\n\nUpdated persisted text.\n":
                raise RuntimeError("Save-as output did not contain the current note")
            state["saved_revision"]=result["revision"]
            sequence.append(("close_saved",lambda _row:("close",state["saved_target"],"--revision",state["saved_revision"])))
            start_next()
        elif key=="close_saved":
            if result.get("status") not in ("closed","closing"):
                raise RuntimeError(f"Saved tab failed to close cleanly: {result}")
            sequence.append(("confirm_saved_closed",lambda _row:("list",)))
            start_next()
        elif key=="confirm_saved_closed":
            still_open=any(row.get("id")==state["saved_target"] for row in result.get("tabs",[]))
            if still_open:
                sequence.insert(0,("confirm_saved_closed",lambda _row:("list",)))
                QTimer.singleShot(100,start_next)
            else:
                sequence.append(("reopen_background",lambda _row:("open",state["save_path"],"--background")))
                start_next()
        elif key=="reopen_background":
            if result.get("status")!="opening" or not result.get("jobId"):
                raise RuntimeError(f"Reopening the closed path did not start an async job: {result}")
            state["reopen_job"]=result["jobId"]
            sequence.insert(0,("reopen_job",lambda _row:("job",state["reopen_job"])))
            QTimer.singleShot(100,start_next)
        elif key=="reopen_job":
            if result.get("status")=="completed":
                if result.get("active") is not False or Path(result.get("path","")).resolve()!=Path(state["save_path"]).resolve():
                    raise RuntimeError(f"Reopened note returned inconsistent tab metadata: {result}")
                state["results"]["document_lifecycle"]={"opened":state["save_path"],"savedAs":state["save_as_path"],"reopened":True}
                finish()
            elif result.get("status") in ("failed","cancelled"):
                raise RuntimeError(f"Reopen job failed: {result}")
            else:
                sequence.insert(0,("reopen_job",lambda _row:("job",state["reopen_job"])))
                QTimer.singleShot(100,start_next)
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
        try:
            captured, capture_error = state["capture"].get_nowait()
        except queue.Empty:
            QTimer.singleShot(20,poll); return
        if capture_error is not None:
            state["failure"]=f"Could not collect CLI output: {capture_error}"; finish(2); return
        returncode,stdout,stderr=captured
        key=state["key"]
        try: on_result(key,parse_output(process,key,returncode,stdout,stderr))
        except Exception as error:
            state["failure"]=str(error); finish(2)
    def finish(code=0):
        if state.get("done"): return
        state["done"]=True
        process=state.get("proc")
        if code and process is not None and process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                try: process.wait(timeout=2)
                except subprocess.TimeoutExpired: pass
            except OSError:
                pass
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
                              "exportPath":state["results"].get("export_path"),
                              "prose_svg_jump":state["results"].get("prose_svg_jump"),
                              "inactive_diagram":state["results"].get("inactive_diagram"),
                              "document_lifecycle":state["results"].get("document_lifecycle")},separators=(",",":")))
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
    QTimer.singleShot(125_000,lambda: (state.update(failure=f"Real viewport CLI flow timed out at {state.get('stage')}"),finish(2)))
    code=app.exec()
    return code

class RealWebEngineAgentRenderTests(unittest.TestCase):
    def test_cli_output_drainer_handles_both_pipes_beyond_windows_buffer_size(self):
        payload="x"*256_000+"🧭東京"
        stderr_payload="y"*256_000+"café"
        code=("import sys; sys.stdout.buffer.write(('x'*256000+'🧭東京').encode('utf-8')); "
              "sys.stdout.flush(); sys.stderr.buffer.write(('y'*256000+'café').encode('utf-8')); sys.stderr.flush()")
        process=subprocess.Popen([sys.executable,"-c",code],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,
                                 encoding="utf-8",errors="strict")
        completed,thread=_drain_process_output(process)
        captured,error=completed.get(timeout=15)
        thread.join(timeout=1)
        self.assertIsNone(error)
        returncode,stdout,stderr=captured
        self.assertEqual(returncode,0)
        self.assertEqual(stdout,payload)
        self.assertEqual(stderr,stderr_payload)

    @unittest.skipUnless((ROOT.parent/"dist"/"qt-reader.html").is_file(),"Build the Qt reader before real WebEngine integration tests")
    def test_real_studio_qml_browser_hook_and_cli_capture_current_reader_pixels(self):
        with tempfile.TemporaryDirectory(prefix="supermd-real-agent-render-") as temp:
            env=dict(os.environ,QT_QPA_PLATFORM="offscreen",QT_QUICK_BACKEND="software",
                     QT_SCALE_FACTOR="2",
                     QTWEBENGINE_DISABLE_SANDBOX="1",QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu --disable-dev-shm-usage")
            result=subprocess.run([sys.executable,str(Path(__file__).resolve()),"--probe",temp],cwd=ROOT,env=env,
                                  capture_output=True,text=True,encoding="utf-8",errors="strict",timeout=150)
        lines=[line for line in result.stdout.splitlines() if line.startswith("{" )]
        self.assertTrue(lines,f"real QML/WebEngine probe emitted no report: {result.stdout}\n{result.stderr}")
        report=json.loads(lines[-1])
        self.assertEqual(result.returncode,0,f"real app probe failed: {report}\n{result.stderr}")
        self.assertTrue(report["ok"],report)
        self.assertIn("read",report["steps"]); self.assertIn("patch",report["steps"])
        self.assertIn("prose_read",report["steps"]); self.assertIn("patch_second_inactive",report["steps"])
        self.assertIn("diagrams_inactive",report["steps"]); self.assertIn("diagram_source_inactive",report["steps"])
        self.assertIn("create_background",report["steps"]); self.assertIn("activate_created",report["steps"])
        self.assertIn("open_background",report["steps"]); self.assertIn("open_job",report["steps"])
        self.assertIn("save_in_place",report["steps"]); self.assertIn("save_as",report["steps"])
        self.assertIn("reopen_job",report["steps"])
        self.assertIn("context",report["steps"])
        self.assertIn("snapshot",report["steps"]); self.assertIn("export",report["steps"])
        self.assertIn("activate_second",report["steps"]); self.assertIn("read_first_draft",report["steps"])
        self.assertIn("read_after_undo",report["steps"])
        self.assertGreaterEqual(report["imageSize"][0],200)
        self.assertLessEqual(max(report["imageSize"]),640)
        self.assertGreater(report["prose_svg_jump"]["end"],0)
        self.assertGreater(report["prose_svg_jump"]["omittedChars"],12_000)
        self.assertTrue(report["inactive_diagram"]["text"])
        self.assertTrue(report["document_lifecycle"]["reopened"])

if __name__=="__main__" and len(sys.argv)>1 and sys.argv[1]=="--probe":
    raise SystemExit(_probe(sys.argv[2]))
