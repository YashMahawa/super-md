"""Outbound client for the Super MD ephemeral cloud relay."""
from __future__ import annotations
import hashlib, json, logging, os, secrets, threading, time, urllib.error, urllib.request, uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from typing import Any, Callable

PAIR_FORMAT = "supermd-agent-pairing"
PAIR_VERSION = 1
MAX_FRAME = 5 * 1024 * 1024

class CloudPairingError(ValueError): pass

def _token(): return secrets.token_urlsafe(48)
def _hash(value: str): return hashlib.sha256(value.encode("utf-8")).hexdigest()
def _group_id(pairing_key: str, connector_key: str):
    return hashlib.sha256(f"supermd-group-v1\0{pairing_key}\0{_hash(connector_key)}".encode()).hexdigest()[:32]

def normalize_origin(value: str) -> str:
    if not isinstance(value, str) or len(value) > 512: raise CloudPairingError("Enter the relay server origin")
    parts = urlsplit(value.strip())
    if parts.scheme not in ("https", "http") or not parts.hostname or parts.username or parts.password:
        raise CloudPairingError("Relay origin must use HTTPS")
    if parts.scheme == "http" and parts.hostname.lower() not in ("localhost", "127.0.0.1", "::1"):
        raise CloudPairingError("Use HTTPS for a non-local relay")
    if parts.path not in ("", "/") or parts.query or parts.fragment: raise CloudPairingError("Enter only the relay origin")
    host = parts.hostname.lower()
    if ":" in host: host = f"[{host}]"
    return urlunsplit((parts.scheme, host + (f":{parts.port}" if parts.port else ""), "", "", ""))

def validate_pairing(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("format") != PAIR_FORMAT or value.get("version") != PAIR_VERSION:
        raise CloudPairingError("This pairing file format is not supported")
    origin = normalize_origin(value.get("serverOrigin", "")); gid=value.get("groupId")
    pk=value.get("pairingKey"); ck=value.get("connectorKey")
    if not isinstance(pk,str) or not 40 <= len(pk) <= 128 or not isinstance(ck,str) or not 40 <= len(ck) <= 128:
        raise CloudPairingError("Pairing credentials are invalid")
    if not isinstance(gid,str) or gid != _group_id(pk,ck): raise CloudPairingError("Pairing keys do not match the workspace ID")
    return {"format":PAIR_FORMAT,"version":PAIR_VERSION,"serverOrigin":origin,"groupId":gid,"pairingKey":pk,"connectorKey":ck}

def new_pairing(server_origin: str):
    pk,ck=_token(),_token()
    return validate_pairing({"format":PAIR_FORMAT,"version":PAIR_VERSION,"serverOrigin":server_origin,"groupId":_group_id(pk,ck),"pairingKey":pk,"connectorKey":ck})

def device_config(pairing: dict[str, Any], display_name="This computer"):
    pair=validate_pairing(pairing); name="".join(c for c in str(display_name) if ord(c)>=32 and ord(c)!=127).strip()[:80] or "This computer"
    return {**pair,"deviceId":str(uuid.uuid4()),"deviceKey":_token(),"displayName":name,"platform":"desktop"}

def read_config_value(config: dict[str, Any]):
    pair=validate_pairing(config); did=config.get("deviceId"); key=config.get("deviceKey")
    try: uuid.UUID(did)
    except (ValueError,TypeError) as e: raise CloudPairingError("Desktop device ID is invalid") from e
    if not isinstance(key,str) or not 40<=len(key)<=128: raise CloudPairingError("Desktop device key is invalid")
    name="".join(c for c in str(config.get("displayName","This computer")) if ord(c)>=32 and ord(c)!=127).strip()[:80] or "This computer"
    return {**pair,"deviceId":did,"deviceKey":key,"displayName":name,"platform":"desktop"}

def read_cloud_config(path):
    file=Path(path)
    if file.is_symlink() or not file.is_file(): raise CloudPairingError("Cloud pairing is not configured")
    if os.name!="nt" and file.stat().st_mode & 0o077: raise CloudPairingError("Cloud pairing file permissions are not private")
    try: return read_config_value(json.loads(file.read_text(encoding="utf-8")))
    except CloudPairingError: raise
    except (OSError,ValueError,UnicodeError) as e: raise CloudPairingError("Cloud pairing file could not be read") from e

def write_cloud_config(path, config):
    dest=Path(path); dest.parent.mkdir(parents=True,exist_ok=True)
    if os.name!="nt": os.chmod(dest.parent,0o700)
    payload=read_config_value(config); tmp=dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as f: json.dump(payload,f,separators=(",",":")); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,dest)
        if os.name!="nt": os.chmod(dest,0o600)
    finally:
        try: tmp.unlink()
        except OSError: pass

def export_pairing(path,config):
    dest=Path(path)
    if dest.suffix.lower()!=".json": dest=dest.with_suffix(".json")
    dest.parent.mkdir(parents=True,exist_ok=True); pair=validate_pairing(config)
    fd=os.open(dest,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as f: json.dump(pair,f,indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
    except Exception:
        try: dest.unlink()
        except OSError: pass
        raise
    if os.name!="nt": os.chmod(dest,0o600)
    return dest

def connector_url(config):
    p=validate_pairing(config); return f"{p['serverOrigin']}/mcp/{p['groupId']}/{p['connectorKey']}"

def enroll(config, timeout=12):
    p=validate_pairing(config); body=json.dumps({**p,"deviceId":config["deviceId"],"deviceKey":config["deviceKey"],"displayName":config.get("displayName","This computer"),"platform":"desktop"},separators=(",",":")).encode()
    req=urllib.request.Request(p["serverOrigin"]+"/device/enroll",data=body,method="POST",headers={"Content-Type":"application/json","Accept":"application/json"})
    try:
        parts=urlsplit(p["serverOrigin"])
        if parts.scheme == "https":
            try:
                from .network_tls import client_context
            except ImportError:
                from network_tls import client_context
            opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=client_context()))
        else:
            opener=urllib.request.build_opener()
        with opener.open(req,timeout=timeout) as response:
            data=response.read(8193)
            if response.status!=200 or len(data)>8192 or json.loads(data.decode()).get("groupId")!=p["groupId"]: raise CloudPairingError("Relay enrollment failed")
    except urllib.error.HTTPError as e:
        if e.code in (400,401): raise CloudPairingError("Relay rejected this pairing file") from None
        raise CloudPairingError(f"Relay enrollment failed (HTTP {e.code})") from None
    except CloudPairingError: raise
    except (OSError,TimeoutError,urllib.error.URLError,ValueError,UnicodeError) as e: raise CloudPairingError("Relay is unreachable or returned an invalid response") from e

def revoke(config, timeout=8):
    """Remove this enrolled device before its local credentials are erased."""
    if not isinstance(timeout,(int,float)) or isinstance(timeout,bool) or not 0.2 <= timeout <= 10:
        raise CloudPairingError("Revocation timeout must be at most 10 seconds")
    value=read_config_value(config); parts=urlsplit(value["serverOrigin"])
    body=json.dumps({"groupId":value["groupId"],"pairingKey":value["pairingKey"],"deviceId":value["deviceId"]},separators=(",",":")).encode()
    req=urllib.request.Request(value["serverOrigin"]+"/device/revoke",data=body,method="POST",headers={"Content-Type":"application/json","Accept":"application/json"})
    try:
        if parts.scheme == "https":
            try:
                from .network_tls import client_context
            except ImportError:
                from network_tls import client_context
            opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=client_context()))
        else:
            opener=urllib.request.build_opener()
        with opener.open(req,timeout=float(timeout)) as response:
            data=response.read(8193)
            result=json.loads(data.decode("utf-8")) if len(data)<=8192 else None
            if response.status!=200 or not isinstance(result,dict) or result.get("groupId")!=value["groupId"] or result.get("revoked") is not True:
                raise CloudPairingError("Relay did not confirm device revocation")
    except urllib.error.HTTPError as e:
        if e.code in (400,401,404): raise CloudPairingError("Relay did not confirm device revocation") from None
        raise CloudPairingError(f"Relay revocation failed (HTTP {e.code})") from None
    except CloudPairingError: raise
    except (OSError,TimeoutError,urllib.error.URLError,ValueError,UnicodeError) as e:
        raise CloudPairingError("Relay revocation could not be confirmed") from e
    return {"revoked":True,"groupId":value["groupId"]}

class CloudRelayClient:
    def __init__(self, handle_rpc: Callable[[dict[str,Any]],dict[str,Any]], on_status=None, connect_factory=None, enroll_fn=enroll):
        self.handle_rpc=handle_rpc; self.on_status=on_status or (lambda _:None); self.connect_factory=connect_factory; self.enroll_fn=enroll_fn
        self._lock=threading.RLock(); self._stop=threading.Event(); self._thread=None; self._socket=None; self._config=None; self._status="Off"
    @property
    def status(self):
        with self._lock:return self._status
    @property
    def enabled(self):
        with self._lock:return bool(self._thread and self._thread.is_alive() and not self._stop.is_set())
    def start(self,config):
        config=read_config_value(config)
        with self._lock:
            if self._thread and self._thread.is_alive():return
            self._config=config; self._stop.clear(); self._thread=threading.Thread(target=self._run,name="supermd-agent-cloud",daemon=True); self._thread.start()
    def stop(self):
        self._stop.set()
        with self._lock:sock=self._socket; thread=self._thread
        if sock:
            try:sock.close(code=1000,reason="Live access disabled")
            except Exception:pass
        if thread and thread is not threading.current_thread():thread.join(timeout=3)
        with self._lock:self._socket=None; self._thread=None; self._status="Off"
        self.on_status("Off")
    def _set(self,status):
        with self._lock:self._status=status
        self.on_status(status)
    def _connect(self,c):
        if self.connect_factory:return self.connect_factory(c)
        try:from websockets.sync.client import connect
        except ImportError as e:raise CloudPairingError("Install the optional websockets package to use cloud live access") from e
        origin=c["serverOrigin"]; parts=urlsplit(origin)
        ws_origin=urlunsplit(("wss" if parts.scheme=="https" else "ws",parts.netloc,parts.path,"",""))
        uri=f"{ws_origin}/device?groupId={c['groupId']}&deviceId={c['deviceId']}"
        ws_logger=logging.getLogger("supermd.agent_cloud.websocket"); ws_logger.disabled=True
        local= urlsplit(origin).hostname in ("localhost","127.0.0.1","::1")
        kwargs={"additional_headers":{"Authorization":"Bearer "+c["deviceKey"],"X-SuperMD-Connector-Hash":_hash(c["connectorKey"]),"X-SuperMD-Display-Name":c["displayName"],"X-SuperMD-Platform":"desktop"},"open_timeout":10,"ping_interval":25,"ping_timeout":15,"close_timeout":3,"max_size":MAX_FRAME,"max_queue":8,"logger":ws_logger,"proxy":None if local else True}
        if parts.scheme == "https":
            try:
                from .network_tls import client_context
            except ImportError:
                from network_tls import client_context
            kwargs["ssl"]=client_context()
        return connect(uri,**kwargs)
    def _run(self):
        c=self._config; delay=1.0
        while c and not self._stop.is_set():
            sock=None
            try:
                self._set("Connecting to relay…"); self.enroll_fn(c); sock=self._connect(c)
                with self._lock:
                    if self._stop.is_set():sock.close(); break
                    self._socket=sock
                registered=json.loads(sock.recv(timeout=10))
                if not isinstance(registered,dict) or registered.get("type")!="registered" or registered.get("groupId")!=c["groupId"] or registered.get("deviceId")!=c["deviceId"]:raise CloudPairingError("Relay registration did not match this paired device")
                delay=1; self._set("Connected to relay")
                while not self._stop.is_set():
                    try:raw=sock.recv(timeout=1)
                    except TimeoutError:continue
                    if raw is None:break
                    if not isinstance(raw,str) or len(raw.encode())>MAX_FRAME:raise CloudPairingError("Relay request exceeded the message limit")
                    msg=json.loads(raw)
                    if not isinstance(msg,dict) or msg.get("type")!="request":raise CloudPairingError("Relay sent an invalid request")
                    rid=msg.get("requestId")
                    if not isinstance(rid,str) or not rid or len(rid)>96:raise CloudPairingError("Relay request id is invalid")
                    try: reply={"type":"reply","requestId":rid,"result":self.handle_rpc(msg)}
                    except Exception as e:reply={"type":"reply","requestId":rid,"error":str(e)[:1500] or "Desktop request failed"}
                    encoded=json.dumps(reply,ensure_ascii=False,separators=(",",":"))
                    if len(encoded.encode())>MAX_FRAME:encoded=json.dumps({"type":"reply","requestId":rid,"error":"Desktop response exceeded the message limit"})
                    sock.send(encoded)
            except Exception as e:
                if not self._stop.is_set():self._set((str(e) if isinstance(e,CloudPairingError) else f"Disconnected ({type(e).__name__}); retrying")[:160])
            finally:
                with self._lock:
                    if self._socket is sock:self._socket=None
                if sock:
                    try:sock.close()
                    except Exception:pass
            if self._stop.wait(delay):break
            delay=min(delay*2,60)
        self._set("Off" if self._stop.is_set() else self.status)
