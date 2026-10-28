"""Actual Qt/loopback verification of the local and cloud desktop bridge."""
from __future__ import annotations
import asyncio, base64, hashlib, json, os, queue, shutil, socket, subprocess, sys, threading, time, unittest, urllib.request
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_QUICK_BACKEND", "software")
from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QGuiApplication
import agent_cloud
import agent_live
import documents
from studio import Studio
from websockets.sync.client import connect
from websockets.sync.server import serve

# Valid 1x1 RGBA PNG; Sharp/libpng rejects the former fixture's bad CRC.
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==")

class QtStudio(QObject):
    agentRequest = Signal(str)
    def __init__(self, window_id):
        super().__init__()
        self.window_id=window_id; self.retired=False; self.active="tab-1"; self.live_source="# Current\n\n```svg\n<svg/>\n```\n"
        self.tabs=[{"id":"tab-1","name":"Current.md","path":"","content":self.live_source,"saved":"","portable":False,"assets":{}}]
        self._agent_job_records={"job-x":{"status":"completed"}}
        self.received=[]
        self.agentRequest.connect(self.on_request)
    def _agent_job_status(self,job_id): return {"jobId":job_id,"status":"completed","format":"pdf","filename":"Current.pdf","bytes":12,"sha256":"a"*64}
    def _agent_document_action(self,request):
        if request["action"]=="create_document": raise AssertionError("create not part of this test")
        if request["action"]=="asset_action": return Studio._attach_tab_asset_native(self,request)
        raise AssertionError(request["action"])
    def on_request(self, raw):
        request=json.loads(raw); action=request["action"]; rid=request["requestId"]
        self.received.append(request)
        tab=self.tabs[0]; revision=hashlib.sha256(self.live_source.encode()).hexdigest()
        def reply(result=None,error=""):
            self.session.agent_bridge.complete(rid,result,error,window_id=self.window_id)
        if action=="flush_current":
            tab["content"]=self.live_source; reply({"flushed":True}); return
        if action=="list_tabs":
            tabs=request["tabs"]
            for row in tabs: row["revision"]=revision; row["sourceLength"]=len(self.live_source)
            reply({"tabs":tabs}); return
        if action=="read_tab":
            start=request.get("offset",0); limit=request.get("limit",12000)
            reply({"tabId":tab["id"],"revision":revision,"offset":start,"markdown":self.live_source[start:start+limit],"totalLength":len(self.live_source)}); return
        if action=="search_tab":
            reply({"tabId":tab["id"],"revision":revision,"matches":[{"line":1,"text":"Current"}]}); return
        if action=="patch_tab":
            if request["expectedRevision"]!=revision: reply(error="stale revision"); return
            self.live_source=self.live_source.replace("Current","Updated",1); tab["content"]=self.live_source
            reply({"revision":hashlib.sha256(self.live_source.encode()).hexdigest(),"changed":True}); return
        if action=="get_context":
            reply({"tabId":tab["id"],"revision":revision,"mode":"live","zoom":100,
                   "reading":{"offset":0,"scrollFraction":0,"visibleText":"Current note","heading":"Current"},"selection":{"text":""}}); return
        if action=="list_diagrams":
            if request.get("expectedRevision") not in (None,revision): reply(error="stale revision"); return
            reply({"tabId":tab["id"],"revision":revision,"diagrams":[{"id":"diagram:24","kind":"svg","sourceStart":24,"sourceEnd":33,"sourceChars":9,"preview":"<svg/>"}]}); return
        if action=="get_diagram":
            if request["expectedRevision"]!=revision: reply(error="stale revision"); return
            reply({"tabId":tab["id"],"revision":revision,"diagramId":request["diagramId"],"source":"<svg/>","start":24,"end":30,"nextOffset":None}); return
        if action=="get_diagram_image":
            reply({"tabId":tab["id"],"revision":revision,"diagramId":request["diagramId"],"mime_type":"image/png","data":base64.b64encode(PNG).decode(),"width":1,"height":1}); return
        if action=="render_tab":
            reply({"tabId":tab["id"],"revision":revision,"mime_type":"image/png","data":base64.b64encode(PNG).decode(),"width":1,"height":1}); return
        if action=="export_document":
            reply({"jobId":"job-x","status":"running","filename":"Current.pdf","format":"pdf"}); return
        if action=="latex_review":
            reply({"tabId":tab["id"],"revision":revision,"repairs":[],"total":0,"truncated":False}); return
        if action=="latex_apply":
            reply({"tabId":tab["id"],"revision":revision,"applied":len(request.get("repairIndices",[]))}); return
        reply(error="unsupported test action")

class DesktopCloudQtIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app=QGuiApplication.instance() or QGuiApplication(["Super MD cloud bridge integration"])
    def setUp(self):
        self.session=SimpleNamespace(windows={})
        self.studio=QtStudio("qt-window")
        self.studio.folder = None
        self.studio.settings = {"newNoteLocation": ""}
        self.studio.readerCall = SimpleNamespace(emit=lambda _value: None)
        self.studio._recover = lambda: None
        self.studio._emit = lambda: None
        self.session.reader_assets = SimpleNamespace(revoke_tab=lambda *_args: None)
        self.session.windows[self.studio.window_id]=self.studio
        self.bridge=agent_live.create_qt_bridge(self.session,Path(__import__("tempfile").mkdtemp()))
        self.session.agent_bridge=self.bridge; self.studio.session=self.session
        self.bridge.start()
    def tearDown(self):
        self.bridge.stop()
        self.app.processEvents()
    def pump_call(self,fn,timeout=5):
        out={}; done=threading.Event()
        def run():
            try: out["result"]=fn()
            except Exception as e: out["error"]=e
            finally: done.set()
        thread=threading.Thread(target=run,daemon=True); thread.start(); deadline=time.monotonic()+timeout
        while not done.is_set() and time.monotonic()<deadline:
            self.app.processEvents(); time.sleep(.003)
        thread.join(.1)
        self.assertTrue(done.is_set(),"loopback operation timed out")
        if "error" in out: raise out["error"]
        return out["result"]
    def test_actual_loopback_http_and_cloud_rpc_source_context_diagram_export_snapshot(self):
        self.studio.live_source="# Current\n\n```svg\n<svg/>\n```\n"
        portable_root=Path(__import__("tempfile").mkdtemp())
        portable_path=portable_root/"Current.smd"
        documents.write_portable(portable_path,self.studio.live_source,{})
        self.studio.tabs[0].update(path=str(portable_path),name=portable_path.name,portable=True,saved=self.studio.live_source,assets={})
        local=agent_live.LiveTabClient(self.bridge.discovery_path)
        tabs=self.pump_call(local.list_tabs)
        self.assertEqual(tabs["tabs"][0]["revision"],hashlib.sha256(self.studio.live_source.encode()).hexdigest())
        page=self.pump_call(lambda:local.read_tab("tab-1",window_id="qt-window",view="source"))
        self.assertIn("<svg/>",page["markdown"])
        context=self.pump_call(lambda:local.get_context("tab-1",window_id="qt-window"))
        self.assertEqual(context["mode"],"live")

        address=socket.socket(); address.bind(("127.0.0.1",0)); port=address.getsockname()[1]; address.close()
        config=agent_cloud.device_config(agent_cloud.new_pairing(f"http://127.0.0.1:{port}"),"Qt desktop")
        ready=threading.Event(); completed=threading.Event(); failures=[]; calls=[]; server_holder={}
        def rpc_server(ws):
            ws.send(json.dumps({"type":"registered","groupId":config["groupId"],"deviceId":config["deviceId"]}))
            actions=[{"action":"list_tabs"}]
            for index,request in enumerate(actions):
                response=None
                if index==0:
                    ws.send(json.dumps({"type":"request","requestId":"list","deviceId":config["deviceId"],**request}))
                    response=json.loads(ws.recv(timeout=8)); calls.append(response)
                    if response.get("error"): failures.append(response["error"]); return
                    row=response["result"]["tabs"][0]
                    tab_id=row["tabId"]; revision=row["revision"]
                    rpc=[
                      {"action":"read_tab","tabId":tab_id,"offset":0,"limit":12000},
                      {"action":"list_diagrams","tabId":tab_id,"expectedRevision":revision},
                      {"action":"get_diagram","tabId":tab_id,"diagramId":"diagram:24","expectedRevision":revision,"offset":0,"limit":12000},
                      {"action":"get_diagram_image","tabId":tab_id,"diagramId":"diagram:24","expectedRevision":revision,"width":1600,"imageFormat":"jpeg"},
                      {"action":"asset_action","tabId":tab_id,"assetAction":"attach","assetName":"assets/model.svg","mimeType":"image/svg+xml","body":base64.b64encode(b"<svg xmlns='http://www.w3.org/2000/svg'/>").decode(),"expectedRevision":revision},
                      {"action":"asset_action","tabId":tab_id,"assetAction":"list","expectedRevision":revision},
                      {"action":"asset_action","tabId":tab_id,"assetAction":"source","assetName":"assets/model.svg","expectedRevision":revision},
                      {"action":"document_action","documentAction":"export","tabId":tab_id,"expectedRevision":revision,"options":{"format":"pdf"}},
                      {"action":"document_action","documentAction":"job_status","tabId":tab_id,"jobId":"job-x"},
                      {"action":"document_action","documentAction":"snapshot","tabId":tab_id,"options":{"width":1600}},
                      {"action":"render_tab","tabId":tab_id,"width":1600,"imageFormat":"jpeg"},
                    ]
                    for n,rpc_request in enumerate(rpc,1):
                        ws.send(json.dumps({"type":"request","requestId":f"r{n}","deviceId":config["deviceId"],**rpc_request}))
                        response=json.loads(ws.recv(timeout=8)); calls.append(response)
                        if response.get("error"): failures.append(response["error"]); break
                        if rpc_request["action"] in ("get_diagram_image","render_tab") or rpc_request.get("documentAction")=="snapshot":
                            result=response["result"]
                            if result.get("mime_type")!="image/png" or not result.get("data"," ").startswith("iVBOR"):
                                failures.append("image response was not PNG")
                    completed.set()
        def server_thread():
            with serve(rpc_server,"127.0.0.1",port,ping_interval=None) as server:
                server_holder["server"]=server; ready.set(); server.serve_forever()
        server=threading.Thread(target=server_thread,daemon=True); server.start()
        self.assertTrue(ready.wait(3))
        client=agent_cloud.CloudRelayClient(self.bridge.handle_cloud_request,
            connect_factory=lambda _config:connect(f"ws://127.0.0.1:{port}",open_timeout=3,ping_interval=None),
            enroll_fn=lambda _config:None)
        client.start(config)
        deadline=time.monotonic()+18
        while not completed.is_set() and not failures and time.monotonic()<deadline:
            self.app.processEvents(); time.sleep(.003)
        client.stop()
        server_holder["server"].shutdown(); server.join(2)
        self.assertTrue(completed.is_set(),f"cloud request sequence did not complete: {failures}")
        self.assertFalse(failures,failures)
        self.assertEqual(len(calls),12)
        self.assertIn("SVG omitted",calls[1]["result"]["markdown"])
        self.assertNotIn("<svg/>",calls[1]["result"]["markdown"])
        self.assertEqual(calls[2]["result"]["diagrams"][0]["id"],"diagram:24")
        self.assertEqual(calls[3]["result"]["source"],"<svg/>")
        self.assertEqual(calls[4]["result"]["mime_type"],"image/png")
        self.assertEqual(calls[5]["result"]["assetName"],"assets/model.svg")
        self.assertEqual(calls[6]["result"]["assets"][0]["name"],"assets/model.svg")
        self.assertEqual(base64.b64decode(calls[7]["result"]["body"]),b"<svg xmlns='http://www.w3.org/2000/svg'/>")
        self.assertEqual(calls[8]["result"]["status"],"running")
        self.assertEqual(calls[9]["result"]["status"],"completed")
        forwarded = [request for request in self.studio.received if request["action"] == "render_tab"][-1]
        self.assertEqual(forwarded["imageFormat"], "jpeg")
        diagram_forwarded = next(request for request in self.studio.received if request["action"] == "get_diagram_image")
        self.assertEqual(diagram_forwarded["imageFormat"], "jpeg")
        with self.assertRaisesRegex(ValueError, "imageFormat must be png or jpeg"):
            self.bridge._call_gui({"action":"render_tab", "tabId":"tab-1", "imageFormat":"webp"})
        with self.assertRaisesRegex(ValueError, "imageFormat must be png or jpeg"):
            self.bridge._call_gui({"action":"get_diagram_image", "tabId":"tab-1", "diagramId":"diagram:24",
                                   "expectedRevision":diagram_forwarded["expectedRevision"], "imageFormat":"webp"})

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for the relay integration test")
    def test_actual_node_relay_and_python_mcp_client_route_through_qt(self):
        node_version=subprocess.run(["node","--version"],capture_output=True,text=True,check=True).stdout.strip().lstrip("v")
        if int(node_version.split(".")[0])<22:self.skipTest("The relay requires Node 22+")
        relay=Path(__file__).resolve().parent.parent/"agent-relay"
        if not (relay/"node_modules").is_dir():self.skipTest("Relay node dependencies are not installed")
        probe=socket.socket();probe.bind(("127.0.0.1",0));port=probe.getsockname()[1];probe.close()
        env=dict(os.environ,HOST="127.0.0.1",PORT=str(port),PUBLIC_HOST=f"127.0.0.1:{port}",DEVICE_REQUEST_TIMEOUT_MS="15000")
        process=subprocess.Popen(["node","dist/index.js"],cwd=relay,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (process.terminate(),process.wait(timeout=3)) if process.poll() is None else None)
        health=f"http://127.0.0.1:{port}/health"; deadline=time.monotonic()+8
        while time.monotonic()<deadline:
            if process.poll() is not None:self.fail("local relay exited before becoming healthy")
            try:
                with urllib.request.urlopen(health,timeout=.2) as response:
                    if response.status==200:break
            except Exception:time.sleep(.05)
        else:self.fail("local relay did not become healthy")
        portable_root=Path(__import__("tempfile").mkdtemp())
        portable_path=portable_root/"Current.smd"
        documents.write_portable(portable_path,self.studio.live_source,{})
        self.studio.tabs[0].update(path=str(portable_path),name=portable_path.name,portable=True,saved=self.studio.live_source,assets={})
        pairing=agent_cloud.device_config(agent_cloud.new_pairing(f"http://127.0.0.1:{port}"),"Qt relay test")
        relay_url=agent_cloud.connector_url(pairing)
        cloud_statuses=[]
        client=agent_cloud.CloudRelayClient(self.bridge.handle_cloud_request,on_status=cloud_statuses.append)
        client.start(pairing)
        self.addCleanup(client.stop)
        deadline=time.monotonic()+8
        while client.status!="Connected to relay" and time.monotonic()<deadline:
            self.app.processEvents();time.sleep(.01)
        self.assertEqual(client.status,"Connected to relay",cloud_statuses)
        result_box={};finished=threading.Event()
        async def mcp_calls():
            from mcp.client.session import ClientSession
            from mcp.client.streamable_http import streamable_http_client
            async with streamable_http_client(relay_url) as (read_stream,write_stream):
                async with ClientSession(read_stream,write_stream) as session:
                    await session.initialize()
                    tools=await session.list_tools()
                    self.assertIn("diagram_action",[tool.name for tool in tools.tools])
                    self.assertIn("asset_action",[tool.name for tool in tools.tools])
                    first=await session.call_tool("list_tabs",{})
                    rows=json.loads(first.content[0].text)["tabs"]
                    tab=rows[0]["id"];revision=rows[0]["revision"]
                    svg_body=b"<svg xmlns='http://www.w3.org/2000/svg'><path d='M0 0L2 2'/></svg>"
                    attached=await session.call_tool("asset_action",{"tabId":tab,"assetAction":"attach","assetName":"assets/model.svg","mimeType":"image/svg+xml","body":base64.b64encode(svg_body).decode(),"expectedRevision":revision})
                    assets=await session.call_tool("asset_action",{"tabId":tab,"assetAction":"list","expectedRevision":revision})
                    original_svg=await session.call_tool("asset_action",{"tabId":tab,"assetAction":"source","assetName":"assets/model.svg","expectedRevision":revision,"offset":0,"limit":12000})
                    original_png_body=base64.b64encode(PNG).decode()
                    await session.call_tool("asset_action",{"tabId":tab,"assetAction":"attach","assetName":"assets/model.png","mimeType":"image/png","body":original_png_body,"expectedRevision":revision})
                    original_png=await session.call_tool("asset_action",{"tabId":tab,"assetAction":"source","assetName":"assets/model.png","expectedRevision":revision})
                    read=await session.call_tool("read_tab",{"tabId":tab,"offset":0,"limit":12000})
                    source_read=await session.call_tool("read_tab",{"tabId":tab,"view":"source","offset":0,"limit":12000})
                    context=await session.call_tool("document_action",{"documentAction":"get_context","tabId":tab,"options":{"limit":500}})
                    try:context_value=json.loads(context.content[0].text)
                    except Exception as error:raise AssertionError(f"context result invalid (error={context.is_error}, text={context.content[0].text!r})") from error
                    diagram_list=await session.call_tool("diagram_action",{"tabId":tab,"diagramAction":"list","expectedRevision":revision})
                    diagrams=json.loads(diagram_list.content[0].text)["diagrams"]
                    source=await session.call_tool("diagram_action",{"tabId":tab,"diagramAction":"source","diagramId":diagrams[0]["id"],"expectedRevision":revision})
                    image=await session.call_tool("diagram_action",{"tabId":tab,"diagramAction":"image","diagramId":diagrams[0]["id"],"expectedRevision":revision})
                    exported=await session.call_tool("document_action",{"documentAction":"export","tabId":tab,"expectedRevision":revision,"options":{"format":"pdf"}})
                    job=json.loads(exported.content[0].text)
                    status=await session.call_tool("document_action",{"documentAction":"job_status","tabId":tab,"options":{"jobId":job["jobId"]}})
                    rendered=await session.call_tool("render_tab",{"tabId":tab,"width":1600})
                    snapshot=await session.call_tool("document_action",{"documentAction":"snapshot","tabId":tab,"options":{"width":1600}})
                    result_box.update(read=read,source_read=source_read,context=context_value,
                                      attach=attached,assets=assets,original_svg=original_svg,original_png=original_png,
                                      diagrams=diagrams,source=source,image=image,export=job,
                                      status=json.loads(status.content[0].text),rendered=rendered,snapshot=snapshot)
        def run_mcp():
            try:asyncio.run(mcp_calls())
            except Exception as error:result_box["error"]=error
            finally:finished.set()
        thread=threading.Thread(target=run_mcp,daemon=True);thread.start();deadline=time.monotonic()+25
        while not finished.is_set() and time.monotonic()<deadline:
            self.app.processEvents();time.sleep(.003)
        self.assertTrue(finished.is_set(),"MCP relay requests did not finish through Qt")
        thread.join(.2)
        if "error" in result_box:raise result_box["error"]
        self.assertIn("SVG omitted",result_box["read"].content[0].text)
        self.assertIn("<svg/>",result_box["source_read"].content[0].text)
        self.assertEqual(result_box["context"]["reading"]["visibleText"],"Current note")
        self.assertIn("assets/model.svg",result_box["assets"].content[0].text)
        self.assertIn("<path",result_box["original_svg"].content[0].text)
        self.assertEqual(result_box["original_png"].content[0].type,"image")
        self.assertEqual(base64.b64decode(result_box["original_png"].content[0].data),PNG)
        self.assertEqual(result_box["diagrams"][0]["id"],"diagram:24")
        self.assertIn("<svg/>",result_box["source"].content[0].text)
        self.assertFalse(result_box["image"].is_error,
                         f"diagram image RPC failed: {[item.text for item in result_box['image'].content if hasattr(item, 'text')]}")
        self.assertEqual(result_box["image"].content[0].type,"image")
        self.assertEqual(result_box["status"]["status"],"completed")
        self.assertEqual(result_box["rendered"].content[0].type,"image")
        self.assertEqual(result_box["snapshot"].content[0].type,"image")

if __name__=="__main__": unittest.main()
