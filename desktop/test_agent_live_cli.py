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
        if action=="create_document":
            tab_id="created-1"; content=request["content"]
            self.tabs.append({"id":tab_id,"name":request.get("title") or "Untitled.md","path":"","content":content,"saved":"","portable":request.get("format")=="smd","assets":{}})
            self.active=tab_id
            return {"tabId":tab_id,"windowId":self.window_id,"revision":hashlib.sha256(content.encode()).hexdigest()}
        if action=="export_document":
            job="job-cli-1"; self._agent_job_records[job]={"status":"running"}
            return {"jobId":job,"status":"running","filename":request.get("filename") or "Current.pdf","format":request["format"]}
        if action=="save_document":
            return {"tabId":request["tabId"],"windowId":self.window_id,"path":"/tmp/Current.md","revision":request["expectedRevision"]}
        if action=="open_document": raise AssertionError(action)
        raise AssertionError(action)
    def _agent_job_status(self,job_id): return {"jobId":job_id,"status":"completed","format":"pdf","filename":"Current.pdf","bytes":12}
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
        if action=="search_tab": self._reply(rid,{"tabId":tab["id"],"revision":revision,"matches":[{"line":1,"text":"CLI note"}]}); return
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
        if action=="list_diagrams": self._reply(rid,{"tabId":tab["id"],"revision":revision,"diagrams":[{"id":"diagram:0","kind":"mermaid","sourceStart":0,"sourceEnd":20,"sourceChars":20,"preview":"graph TD"}]}); return
        if action=="get_diagram": self._reply(rid,{"tabId":tab["id"],"revision":revision,"diagramId":request["diagramId"],"source":"graph TD; A-->B","start":0,"end":15,"nextOffset":None}); return
        if action=="render_tab": self._reply(rid,{"tabId":tab["id"],"revision":revision,"mime_type":"image/png","data":base64.b64encode(PNG).decode(),"width":1,"height":1}); return
        self._reply(rid,error="unsupported test action")

class LiveCLISubprocessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.app=QGuiApplication.instance() or QGuiApplication(["Super MD live CLI tests"])
    def setUp(self):
        self.temp=Path(tempfile.mkdtemp()); self.studio=FakeStudio(); self.session=SimpleNamespace(windows={self.studio.window_id:self.studio})
        self.bridge=agent_live.create_qt_bridge(self.session,self.temp/"data"); self.session.agent_bridge=self.bridge; self.studio.session=self.session; self.bridge.start()
        self.cli=Path(__file__).with_name("agent_cli.py"); self.env=dict(os.environ,QT_QPA_PLATFORM="offscreen")
    def tearDown(self): self.bridge.stop(); self.app.processEvents()
    def run_cli(self,*args,timeout=5):
        process=subprocess.Popen([sys.executable,str(self.cli),"live","--sessions-dir",str(self.bridge.discovery_dir),*map(str,args)],cwd=self.cli.parent,env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
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
        self.assertEqual(self.run_cli("search",tab,"note")[1]["result"]["matches"][0]["line"],1)
        ops=json.dumps([{"type":"replace","old":"text","new":"edited"}])
        self.assertTrue(self.run_cli("patch",tab,"--revision",revision,"--operations-json",ops)[1]["result"]["changed"])
        updated=self.run_cli("list")[1]["result"]["tabs"][0]["revision"]
        self.assertEqual(len(self.run_cli("latex-review",tab)[1]["result"]["repairs"]),1)
        self.assertEqual(self.run_cli("latex-apply",tab,"--revision",updated,"--indices","0")[1]["result"]["applied"],1)
        diagrams=self.run_cli("diagrams",tab,"--revision",updated)[1]["result"]["diagrams"]
        self.assertEqual(diagrams[0]["id"],"diagram:0")
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
        result=subprocess.run([sys.executable,str(self.cli),"live","--sessions-dir",str(missing),"list"],cwd=self.cli.parent,env=env,capture_output=True,text=True,timeout=5)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(result.stderr,"")
        self.assertEqual(json.loads(result.stdout)["ok"],False)

if __name__=="__main__": unittest.main()
