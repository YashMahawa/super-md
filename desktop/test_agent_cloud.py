from __future__ import annotations
import hashlib, json, os, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace

import agent_cloud
import network_tls
from unittest.mock import patch

class FakeSocket:
    def __init__(self, config, *, mismatch=False, requests=()):
        self.config=config; self.mismatch=mismatch; self.requests=list(requests); self.sent=[]; self.closed=False
        group=config["groupId"] if not mismatch else "0" * 32
        self.queue=[json.dumps({"type":"registered","groupId":group,"deviceId":config["deviceId"]})]+list(self.requests)
    def recv(self, timeout=None):
        if self.closed: return None
        if self.queue: return self.queue.pop(0)
        time.sleep(min(timeout or 0,0.02))
        raise ConnectionError("test relay disconnected")
    def send(self, value): self.sent.append(json.loads(value))
    def close(self, **_kwargs): self.closed=True

class CloudPairingTests(unittest.TestCase):
    def test_pairing_derivation_import_export_permissions_and_url(self):
        with tempfile.TemporaryDirectory() as temp:
            config=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.example.test"),"Desk")
            self.assertEqual(config["groupId"],hashlib.sha256(f"supermd-group-v1\0{config['pairingKey']}\0{hashlib.sha256(config['connectorKey'].encode()).hexdigest()}".encode()).hexdigest()[:32])
            path=Path(temp)/"agent-cloud.json"; agent_cloud.write_cloud_config(path,config)
            self.assertEqual(agent_cloud.read_cloud_config(path)["deviceId"],config["deviceId"])
            if os.name!="nt": self.assertEqual(path.stat().st_mode&0o777,0o600)
            pairing=Path(temp)/"pairing.json"; agent_cloud.export_pairing(pairing,config)
            exported=json.loads(pairing.read_text())
            self.assertNotIn("deviceKey",exported); self.assertNotIn("deviceId",exported)
            self.assertEqual(agent_cloud.connector_url(config),f"https://relay.example.test/mcp/{config['groupId']}/{config['connectorKey']}")
            with self.assertRaises(FileExistsError): agent_cloud.export_pairing(pairing,config)
            exported["groupId"]="f"*32
            with self.assertRaises(agent_cloud.CloudPairingError): agent_cloud.validate_pairing(exported)

    def test_http_origin_restrictions_and_local_dev_exception(self):
        self.assertEqual(agent_cloud.normalize_origin("http://127.0.0.1:8787/"),"http://127.0.0.1:8787")
        with self.assertRaises(agent_cloud.CloudPairingError): agent_cloud.normalize_origin("http://relay.example.test")
        with self.assertRaises(agent_cloud.CloudPairingError): agent_cloud.normalize_origin("https://relay.example.test/mcp")

    def test_reconnect_enrolls_each_time_for_ephemeral_relay_state(self):
        config=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.example.test"))
        enrolled=[]; connected=[]; received=threading.Event(); sockets=[]
        frame=json.dumps({"type":"request","requestId":"req-1","action":"list_tabs"})
        def factory(value):
            connected.append(value["deviceId"])
            sock=FakeSocket(value,requests=(frame,)); sockets.append(sock); return sock
        def handler(request):
            self.assertEqual(request["action"],"list_tabs"); received.set(); return {"tabs":[]}
        client=agent_cloud.CloudRelayClient(handler,connect_factory=factory,enroll_fn=lambda value:enrolled.append(value["groupId"]))
        client.start(config)
        self.assertTrue(received.wait(2))
        deadline=time.monotonic()+2
        while len(connected)<2 and time.monotonic()<deadline: time.sleep(.01)
        client.stop()
        self.assertGreaterEqual(len(connected),2)
        self.assertEqual(len(enrolled),len(connected))
        self.assertEqual(sockets[0].sent[0],{"type":"reply","requestId":"req-1","result":{"tabs":[]}})
        self.assertEqual(client.status,"Off")

    def test_wrong_group_registration_never_reports_connected(self):
        config=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.example.test"))
        statuses=[]; socket=FakeSocket(config,mismatch=True)
        client=agent_cloud.CloudRelayClient(lambda _r:{},on_status=statuses.append,
            connect_factory=lambda _c:socket,enroll_fn=lambda _c:None)
        client.start(config)
        deadline=time.monotonic()+2
        while not any("did not match" in s for s in statuses) and time.monotonic()<deadline:time.sleep(.01)
        client.stop()
        self.assertIn("Relay registration did not match this paired device",statuses)
        self.assertNotIn("Connected to relay",statuses)
        self.assertTrue(socket.closed)

    def test_offline_relay_retries_with_backoff_and_stops_cleanly(self):
        config=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.example.test"))
        statuses=[]; connections=[]; attempts=[]
        def reject(_config):
            attempts.append(time.monotonic())
            raise agent_cloud.CloudPairingError("Relay is unreachable or returned an invalid response")
        client=agent_cloud.CloudRelayClient(lambda _r:{},on_status=statuses.append,
            connect_factory=lambda _c:connections.append(True),enroll_fn=reject)
        client.start(config)
        deadline=time.monotonic()+2
        while len(attempts)<2 and time.monotonic()<deadline:time.sleep(.01)
        client.stop()
        self.assertGreaterEqual(len(attempts),2)
        self.assertEqual(connections,[])
        self.assertIn("Relay is unreachable or returned an invalid response",statuses)
        self.assertEqual(client.status,"Off")

    def test_enrollment_payload_matches_relay_and_rejects_invalid_pairing(self):
        config=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.example.test"))
        captured={}
        def fake_urlopen(request,timeout):
            captured["url"]=request.full_url; captured["body"]=json.loads(request.data); captured["timeout"]=timeout
            class Response:
                status=200
                def read(self,_limit): return b'{"groupId":"'+config["groupId"].encode()+b'"}'
                def __enter__(self): return self
                def __exit__(self,*_args): return None
            return Response()
        class FakeOpener:
            def open(self,request,timeout): return fake_urlopen(request,timeout)
        with patch.object(agent_cloud.urllib.request,"build_opener",return_value=FakeOpener()):
            agent_cloud.enroll(config)
        self.assertEqual(captured["url"],"https://relay.example.test/device/enroll")
        self.assertEqual(captured["body"]["pairingKey"],config["pairingKey"])
        self.assertEqual(captured["body"]["connectorKey"],config["connectorKey"])
        self.assertEqual(captured["body"]["platform"],"desktop")

    def test_https_enrollment_and_websocket_use_augmented_verified_tls(self):
        config=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.example.test"))
        context=object(); seen={}
        class FakeOpener:
            def open(self,request,timeout):
                seen["request"]=request
                class Response:
                    status=200
                    def read(self,_limit): return b'{"groupId":"'+config["groupId"].encode()+b'"}'
                    def __enter__(self): return self
                    def __exit__(self,*_args): return None
                return Response()
        handler=object()
        with patch("network_tls.client_context",return_value=context) as tls, \
             patch.object(agent_cloud.urllib.request,"HTTPSHandler",return_value=handler) as https_handler, \
             patch.object(agent_cloud.urllib.request,"build_opener",return_value=FakeOpener()):
            agent_cloud.enroll(config)
            tls.assert_called_once()
            https_handler.assert_called_once_with(context=context)

        from websockets.sync import client as ws_client
        with patch("network_tls.client_context",return_value=context) as tls, \
             patch.object(ws_client,"connect",side_effect=lambda uri,**kwargs: seen.update(uri=uri,kwargs=kwargs) or object()):
            cloud=agent_cloud.CloudRelayClient(lambda _request:{})
            cloud._connect(config)
        tls.assert_called_once()
        self.assertIs(seen["kwargs"]["ssl"],context)
        self.assertTrue(seen["uri"].startswith("wss://relay.example.test/device?"))

    def test_revoke_posts_only_device_identity_over_verified_tls_with_bounded_timeout(self):
        config=agent_cloud.device_config(agent_cloud.new_pairing("https://relay.example.test"))
        context=object(); captured={}
        class FakeOpener:
            def open(self,request,timeout):
                captured.update(url=request.full_url,body=json.loads(request.data),timeout=timeout)
                class Response:
                    status=200
                    def read(self,_limit): return json.dumps({"revoked":True,"groupId":config["groupId"]}).encode()
                    def __enter__(self): return self
                    def __exit__(self,*_args): return None
                return Response()
        with patch("network_tls.client_context",return_value=context), \
             patch.object(agent_cloud.urllib.request,"HTTPSHandler") as https_handler, \
             patch.object(agent_cloud.urllib.request,"build_opener",return_value=FakeOpener()):
            result=agent_cloud.revoke(config,timeout=8)
        https_handler.assert_called_once_with(context=context)
        self.assertEqual(result,{"revoked":True,"groupId":config["groupId"]})
        self.assertEqual(captured["url"],"https://relay.example.test/device/revoke")
        self.assertEqual(captured["body"],{"groupId":config["groupId"],"pairingKey":config["pairingKey"],"deviceId":config["deviceId"]})
        self.assertNotIn("connectorKey",captured["body"])
        self.assertNotIn("deviceKey",captured["body"])
        self.assertLessEqual(captured["timeout"],10)
        with self.assertRaises(agent_cloud.CloudPairingError): agent_cloud.revoke(config,timeout=11)

if __name__=="__main__": unittest.main()
