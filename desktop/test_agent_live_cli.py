"""Subprocess CLI coverage against a protected, event-pumped Qt bridge."""
from __future__ import annotations
import base64, hashlib, json, os, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QGuiApplication
import agent_live

PNG=base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=")

class FakeStudio(QObject):
    agentRequest=Signal(str)
    def __init__(self):
        super().__init__(); self.window_id="cli-window"; self.retired=False; self.active="tab-1"
        self.tabs=[{"id":"tab-1","name":"Current.md","path":"","content":"# CLI note\n\ntext\n","saved":"","portable":False,"assets":{}}]
        self._agent_job_records={}; self.agentRequest.connect(self._on_request)
    def _reply(self,rid,result=None,error=""):
        self.session.agent_bridge.complete(rid,result,error,window_id=self.window_id)
    def _agent_document_action(self,request):
        action=request["action"]
        self.last_document_action=request
        if action=="patch_tab":
            tab=next(item for item in self.tabs if item["id"]==request["tabId"])
            revision=hashlib.sha256(tab["content"].encode()).hexdigest()
            if request.get("expectedRevision")!=revision: raise ValueError("Live tab revision changed")
            old=tab["content"]
            for operation in request["operations"]:
                if operation["type"]=="replace": tab["content"]=tab["content"].replace(operation["old"],operation["new"],1)
            updated=hashlib.sha256(tab["content"].encode()).hexdigest()
            return {"tabId":tab["id"],"revision":updated,"sourceLength":len(tab["content"]),
                    "changed":tab["content"]!=old,"applied":len(request["operations"]),"operation_results":[]}
        if action=="create_document":
            tab_id="created-1"; content=request["content"]
            name=request.get("title") or request.get("filename") or ("Untitled.smd" if request.get("format")=="smd" else "Untitled.md")
            self.tabs.append({"id":tab_id,"name":name,"path":"","content":content,"saved":"","portable":request.get("format")=="smd","assets":{}})
            if not request.get("background",False): self.active=tab_id
            return {"tabId":tab_id,"windowId":self.window_id,"revision":hashlib.sha256(content.encode()).hexdigest(),
                    "title":name,"path":"","format":request.get("format","md"),"active":self.active==tab_id,
                    "sourceLength":len(content),"isDirty":True}
        if action=="export_document":
            job="job-cli-1"; self._agent_job_records[job]={"status":"running"}
            return {"jobId":job,"status":"running","filename":request.get("filename") or "Current.pdf","format":request["format"]}
        if action=="save_document":
            return {"tabId":request["tabId"],"windowId":self.window_id,"path":"/tmp/Current.md","revision":request["expectedRevision"]}
        if action=="activate_document":
            self.active=request["tabId"]
            tab=next(item for item in self.tabs if item["id"]==self.active)
            return {"tabId":self.active,"windowId":self.window_id,"revision":hashlib.sha256(tab["content"].encode()).hexdigest(),"active":True}
        if action=="close_document":
            tab=next(item for item in self.tabs if item["id"]==request["tabId"])
            self.tabs.remove(tab)
            if not self.tabs: self.active=""
            elif self.active==tab["id"]: self.active=self.tabs[0]["id"]
            return {"status":"closed","tabId":tab["id"],"windowId":self.window_id}
        if action=="open_document": raise AssertionError(action)
        if action=="replace_tab_asset":
            if request.get("expectedRevision")!=hashlib.sha256(self.tabs[0]["content"].encode()).hexdigest():
                raise ValueError("Live tab revision changed; inspect it again before replacing an asset")
            return {"tabId":request["tabId"],"assetName":request["assetName"],"revision":request["expectedRevision"],"changed":True}
        if action=="asset_action" and request.get("assetAction")=="attach":
            if request.get("expectedRevision")!=hashlib.sha256(self.tabs[0]["content"].encode()).hexdigest():
                raise ValueError("Live tab revision changed; inspect it again before attaching an asset")
            return {"tabId":request["tabId"],"asset":"assets/attached.svg","revision":request["expectedRevision"],"saved":True}
        raise AssertionError(action)
    def _agent_job_status(self,job_id): return {"jobId":job_id,"status":"completed","format":"pdf","filename":"Current.pdf","bytes":12}
    def _agent_export_chunk(self,job_id,offset=0,limit=262144):
        data=b"fake artifact"; body=data[offset:offset+limit]; next_offset=offset+len(body)
        return {"jobId":job_id,"filename":"fake artifact.pdf","format":"pdf","mimeType":"application/pdf",
                "bytes":len(data),"sha256":hashlib.sha256(data).hexdigest(),"offset":offset,
                "nextOffset":next_offset if next_offset<len(data) else None,"body":base64.b64encode(body).decode()}
    def _on_request(self,raw):
        request=json.loads(raw); action=request["action"]; rid=request["requestId"]
        tab=next((item for item in self.tabs if item["id"]==request.get("tabId",self.active)),self.tabs[0])
        revision=hashlib.sha256(tab["content"].encode()).hexdigest(); source=tab["content"]
        if action=="flush_current": self._reply(rid,{"flushed":True}); return
        if action=="list_tabs":
            rows=request["tabs"]
            for row in rows:
                current=next((item for item in self.tabs if item["id"]==row["id"]),None)
                if current:
                    row["revision"]=hashlib.sha256(current["content"].encode()).hexdigest(); row["sourceLength"]=len(current["content"])
            self._reply(rid,{"tabs":rows}); return
        if action=="read_tab":
            start=request.get("offset",0); end=min(len(source),start+request.get("limit",12000))
            self._reply(rid,{"tabId":tab["id"],"revision":revision,"offset":start,"start":start,"end":end,"nextOffset":end if end<len(source) else None,"totalChars":len(source),"markdown":source[start:end],"text":source[start:end],"omissions":[]}); return
        if action=="search_tab":
            self.last_search_request=request
            self._reply(rid,{"tabId":tab["id"],"revision":revision,"matches":[{"line":1,"text":"CLI note"}],"nextOffset":None}); return
        if action=="patch_tab":
            if request["expectedRevision"]!=revision: self._reply(rid,error="stale revision"); return
            op=request["operations"][0]; tab["content"]=tab["content"].replace(op["old"],op["new"],1)
            self._reply(rid,{"revision":hashlib.sha256(tab["content"].encode()).hexdigest(),"changed":True}); return
        if action=="get_context": self._reply(rid,{"tabId":tab["id"],"revision":revision,"mode":"live","zoom":100,"reading":{"offset":0,"scrollFraction":0,"visibleText":"CLI note","heading":"CLI note"},"selection":{"text":""}}); return
        if action=="export_document":
            self._agent_job_records["job-cli-1"]={"status":"running"}
            self._reply(rid,{"jobId":"job-cli-1","status":"running","filename":"Current.pdf","format":request["format"]}); return
        if action=="latex_review": self._reply(rid,{"tabId":tab["id"],"revision":revision,"repairs":[{"index":0,"before":"a","after":"b","reason":"test"}],"total":1,"truncated":False}); return
        if action=="latex_apply": self._reply(rid,{"tabId":tab["id"],"revision":revision,"applied":len(request["repairIndices"])}); return
        if action=="list_diagrams":
            self.last_diagram_list_request=request
            self._reply(rid,{"tabId":tab["id"],"revision":revision,"diagrams":[{"id":"diagram:0","kind":"mermaid","sourceStart":0,"sourceEnd":20,"sourceChars":20,"preview":"graph TD"}]}); return
        if action=="get_diagram": self._reply(rid,{"tabId":tab["id"],"revision":revision,"diagramId":request["diagramId"],"source":"graph TD; A-->B","start":0,"end":15,"nextOffset":None}); return
        if action=="get_diagram_image":
            self.last_diagram_image_width=request.get("width")
            if request.get("expectedRevision")!=revision: self._reply(rid,error="A current expectedRevision is required to retrieve this diagram"); return
            self._reply(rid,{"tabId":tab["id"],"revision":revision,"diagramId":request["diagramId"],"mime_type":"image/png","data":base64.b64encode(PNG).decode(),"width":1,"height":1}); return
        if action=="render_tab": self._reply(rid,{"tabId":tab["id"],"revision":revision,"mime_type":"image/png","data":base64.b64encode(PNG).decode(),"width":1,"height":1}); return
        self._reply(rid,error="unsupported test action")

class LiveCLISubprocessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.app=QGuiApplication.instance() or QGuiApplication(["Super MD live CLI tests"])
    def setUp(self):
        self.temp=Path(tempfile.mkdtemp()); self.studio=FakeStudio(); self.session=SimpleNamespace(windows={self.studio.window_id:self.studio})
        self.bridge=agent_live.create_qt_bridge(self.session,self.temp/"data"); self.session.agent_bridge=self.bridge; self.studio.session=self.session; self.bridge.start()
        self.cli=Path(__file__).with_name("agent_cli.py"); self.env=dict(os.environ,QT_QPA_PLATFORM="offscreen")
    def tearDown(self):
        self.bridge.stop()
        if hasattr(self.studio,"stop"):
            self.studio.stop()
            self.studio.pool.shutdown(wait=False,cancel_futures=True)
            self.studio.session.writes.shutdown(wait=False)
        self.app.processEvents()
    def run_cli(self,*args,timeout=5):
        process=subprocess.Popen([sys.executable,str(self.cli),"live","--sessions-dir",str(self.bridge.discovery_dir),*map(str,args)],cwd=self.cli.parent,env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding="utf-8",errors="strict")
        deadline=time.monotonic()+timeout
        while process.poll() is None and time.monotonic()<deadline:
            self.app.processEvents(); time.sleep(.003)
        if process.poll() is None: process.kill(); self.fail("live CLI subprocess timed out")
        stdout,stderr=process.communicate()
        self.assertEqual(stderr,"",stderr)
        try: value=json.loads(stdout)
        except ValueError as error: self.fail(f"CLI did not emit one JSON response: {stdout!r}")
        self.assertEqual(value.get("ok"),process.returncode==0,value)
        return process.returncode,value
    def test_subprocess_live_tab_actions_and_snapshot_output(self):
        code,value=self.run_cli("list"); self.assertEqual(code,0)
        tab=value["result"]["tabs"][0]["id"]
        revision=value["result"]["tabs"][0]["revision"]
        self.assertIn(":cli-window:tab-1",tab)
        self.assertEqual(self.run_cli("context",tab)[1]["result"]["reading"]["visibleText"],"CLI note")
        self.assertIn("CLI note",self.run_cli("read",tab,"--view","source")[1]["result"]["markdown"])
        self.assertEqual(self.run_cli("read", tab, "--heading", "CLI note", "--view", "source")[1]["result"]["heading"]["title"], "CLI note")
        self.assertEqual(self.run_cli("read", tab, "--heading", "0", "--view", "source")[1]["result"]["heading"]["index"], 0)
        self.assertEqual(self.run_cli("search",tab,"note")[1]["result"]["matches"][0]["line"],1)
        self.assertEqual(self.run_cli("search",tab,"note","--offset","4","--case-sensitive",
                                      "--whole-word","--regex","--exclude-diagrams")[0],0)
        ops=json.dumps([{"type":"replace","old":"text","new":"edited"}])
        self.assertTrue(self.run_cli("patch",tab,"--revision",revision,"--operations-json",ops)[1]["result"]["changed"])
        updated=self.run_cli("list")[1]["result"]["tabs"][0]["revision"]
        self.assertEqual(len(self.run_cli("latex-review",tab)[1]["result"]["repairs"]),1)
        self.assertEqual(self.run_cli("latex-apply",tab,"--revision",updated,"--indices","0")[1]["result"]["applied"],1)
        diagrams=self.run_cli("diagrams",tab,"--revision",updated)[1]["result"]["diagrams"]
        self.assertEqual(diagrams[0]["id"],"diagram:0")
        self.assertEqual((self.studio.last_diagram_list_request["offset"],
                          self.studio.last_diagram_list_request["limit"]), (0, 80))
        self.assertEqual(self.run_cli("diagrams", tab, "--offset", "3", "--limit", "5")[0], 0)
        self.assertEqual((self.studio.last_diagram_list_request["offset"],
                          self.studio.last_diagram_list_request["limit"]), (3, 5))
        self.assertIn("graph TD",self.run_cli("diagram",tab,"diagram:0","--revision",updated)[1]["result"]["source"])
        snapshot=self.temp/"snapshot"
        meta=self.run_cli("snapshot",tab,snapshot)[1]["result"]
        image_path=Path(meta["path"]); self.assertEqual(image_path.suffix,".png"); self.assertEqual(image_path.read_bytes(),PNG)
        self.assertNotEqual(self.run_cli("snapshot",tab,image_path)[0],0)
        self.assertEqual(self.run_cli("export",tab,"pdf","--revision",updated)[1]["result"]["status"],"running")
        job_id=self.run_cli("export",tab,"pdf","--revision",updated)[1]["result"]["jobId"]
        self.assertEqual(self.run_cli("job",job_id)[1]["result"]["status"],"completed")
        content=self.temp/"new.md"; content.write_text("# New note\n",encoding="utf-8")
        created=self.run_cli("create","--content-file",content,"--title","Created")[1]["result"]
        self.assertEqual(created["tabId"],"created-1")

    def test_command_is_headless_and_requires_private_sessions_directory(self):
        env=dict(self.env,QT_QPA_PLATFORM="invalid"); missing=self.temp/"missing-sessions"
        result=subprocess.run([sys.executable,str(self.cli),"live","--sessions-dir",str(missing),"list"],cwd=self.cli.parent,env=env,capture_output=True,text=True,encoding="utf-8",errors="strict",timeout=5)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(result.stderr,"")
        self.assertEqual(json.loads(result.stdout)["ok"],False)

    def test_download_reassembles_registered_export_without_overwriting(self):
        self.studio._agent_job_records["export-job"]={"action":"export_document","status":"completed"}
        output = self.temp / "résumé export.pdf"
        job_id = f"{self.bridge.session_id}:export-job"
        code, value = self.run_cli("download", job_id, output)
        self.assertEqual(code, 0)
        self.assertEqual(output.read_bytes(), b"fake artifact")
        self.assertEqual(value["result"]["filename"], "fake artifact.pdf")
        self.assertEqual(value["result"]["format"], "pdf")
        self.assertEqual(value["result"]["bytes"], len(b"fake artifact"))
        self.assertEqual(value["result"]["sha256"], hashlib.sha256(b"fake artifact").hexdigest())

        existing = self.temp / "keep.pdf"
        existing.write_bytes(b"keep")
        self.assertNotEqual(self.run_cli("download", job_id, existing)[0], 0)
        self.assertEqual(existing.read_bytes(), b"keep")

    def test_live_asset_metadata_diagram_image_and_asset_extract(self):
        tab=self.run_cli("list")[1]["result"]["tabs"][0]["id"]
        revision=self.run_cli("list")[1]["result"]["tabs"][0]["revision"]
        self.studio.tabs[0]["assets"]={"assets/vector.svg":"data:image/svg+xml;base64,PHN2Zy8+"}

        assets=self.run_cli("assets",tab,"--offset",0,"--limit",10)[1]["result"]
        self.assertEqual(assets["assetCount"],1)
        self.assertEqual(assets["assets"][0]["name"],"assets/vector.svg")
        self.assertNotIn("data",json.dumps(assets))

        diagram_path=self.temp/"diagram"
        diagram=self.run_cli("diagram-image",tab,"diagram:0",diagram_path,"--revision",revision,"--width",640)[1]["result"]
        self.assertEqual(self.studio.last_diagram_image_width,640)
        self.assertEqual(Path(diagram["path"]).suffix,".png")
        self.assertEqual(Path(diagram["path"]).read_bytes(),PNG)
        existing=Path(diagram["path"])
        self.assertNotEqual(self.run_cli("diagram-image",tab,"diagram:0",existing,"--revision",revision)[0],0)
        self.assertEqual(existing.read_bytes(),PNG)
        self.assertNotEqual(self.run_cli("diagram-image",tab,"diagram:0",self.temp/"stale.png","--revision","0"*64)[0],0)

        extracted=self.run_cli("extract",tab,"assets/vector.svg",self.temp/"vector","--revision",revision)[1]["result"]
        self.assertEqual(Path(extracted["path"]).suffix,".svg")
        self.assertEqual(Path(extracted["path"]).read_bytes(),b"<svg/>")
        self.assertNotIn("data",json.dumps(extracted))
        self.assertNotEqual(self.run_cli("extract",tab,"assets/vector.svg",extracted["path"],"--revision",revision)[0],0)
        self.assertNotEqual(self.run_cli("extract",tab,"assets/vector.svg",self.temp/"stale.svg","--revision","0"*64)[0],0)

    def test_cli_background_create_activate_save_as_and_close_flags(self):
        content=self.temp/"background.smd"; content.write_text("# Background\n",encoding="utf-8")
        created=self.run_cli("create","--content-file",content,"--filename","background.smd","--background")[1]["result"]
        self.assertFalse(created["active"])
        self.assertTrue(self.studio.last_document_action["background"])
        self.assertEqual(self.studio.last_document_action["format"],"smd")
        target=created["target"]
        self.run_cli("activate",target)
        self.assertEqual(self.studio.last_document_action["action"],"activate_document")
        self.run_cli("save",target,"--revision",created["revision"],"--save-as")
        self.assertTrue(self.studio.last_document_action["saveAs"])
        self.run_cli("close",target,"--revision",created["revision"],"--discard-changes")
        self.assertTrue(self.studio.last_document_action["discardChanges"])

    def test_asset_mutation_preflight_and_live_replace_revision_guard(self):
        tab=self.run_cli("list")[1]["result"]["tabs"][0]["id"]
        revision=self.run_cli("list")[1]["result"]["tabs"][0]["revision"]
        valid=self.temp/"replacement.svg"; valid.write_bytes(b"<svg/>")
        replaced=self.run_cli("replace-asset",tab,"stable-asset-id",valid,"--revision",revision)
        self.assertEqual(replaced[0],0,replaced[1])
        self.assertEqual(replaced[1]["result"]["assetName"],"stable-asset-id")
        self.assertNotEqual(self.run_cli("replace-asset",tab,"stable-asset-id",valid,"--revision","0"*64)[0],0)

        unsupported=self.temp/"replacement.txt"; unsupported.write_text("not an image")
        self.assertNotEqual(self.run_cli("replace-asset",tab,"asset",unsupported,"--revision",revision)[0],0)
        oversized=self.temp/"oversized.png"
        with oversized.open("wb") as stream: stream.truncate(25*1024*1024+1)
        self.assertNotEqual(self.run_cli("replace-asset",tab,"asset",oversized,"--revision",revision)[0],0)

    def test_live_attach_sends_only_local_path_and_revision(self):
        tab=self.run_cli("list")[1]["result"]["tabs"][0]["id"]
        revision=self.run_cli("list")[1]["result"]["tabs"][0]["revision"]
        source=self.temp/"new.svg"; source.write_bytes(b"<svg/>")
        code,value=self.run_cli("attach",tab,source,"--revision",revision,"--name","attached.svg")
        self.assertEqual(code,0,value)
        self.assertEqual(value["result"]["asset"],"assets/attached.svg")
        self.assertNotIn("data",json.dumps(value))

    def test_attach_through_actual_local_bridge_and_studio(self):
        from documents import write_portable
        from studio import Session, Studio

        self.bridge.stop()
        session=Session(True)
        session.settings["newNoteLocation"]=str(self.temp)
        studio=Studio(True,session)
        note_path=self.temp/"Attached note.smd"
        markdown="# Portable note\n\nKeep the note text.\n"
        write_portable(note_path,markdown,{})
        note=studio._note(note_path.name,markdown,str(note_path),markdown,{},True)
        studio.tabs=[note]
        studio.active=note["id"]
        studio.mode="live"
        bridge=agent_live.create_qt_bridge(session,session.data)
        session.agent_bridge=bridge

        def handle_native_request(raw):
            request=json.loads(raw)
            try:
                result={"flushed":True} if request["action"]=="flush_current" else studio._agent_document_action(request)
                bridge.complete(request["requestId"],result,window_id=studio.window_id)
            except Exception as error:
                bridge.complete(request["requestId"],None,str(error),window_id=studio.window_id)

        studio.agentRequest.connect(handle_native_request)
        bridge.start()
        self.studio=studio
        self.bridge=bridge
        asset=self.temp/"local image.png"
        asset.write_bytes(PNG)
        row=self.run_cli("list")[1]["result"]["tabs"][0]
        first=self.run_cli("attach",row["id"],asset,"--revision",row["revision"],"--name","local.png")
        self.assertEqual(first[0],0,first[1])
        self.assertNotIn("data",json.dumps(first[1]))
        self.assertEqual(set(note["assets"]),{"assets/local.png"})

        note["content"]+="\nChanged after inspection.\n"
        stale=self.run_cli("attach",row["id"],asset,"--revision",row["revision"],"--name","stale.png")
        self.assertNotEqual(stale[0],0)
        self.assertEqual(set(note["assets"]),{"assets/local.png"})

if __name__=="__main__": unittest.main()
