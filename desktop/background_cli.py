"""Control the per-user application service over its private local socket."""
import argparse,hashlib,json,os,subprocess,sys,time
from pathlib import Path

def main(argv):
    parser=argparse.ArgumentParser(description='Super MD background service')
    parser.add_argument('action',choices=['start','status','stop'])
    args=parser.parse_args(argv)
    from PySide6.QtCore import QCoreApplication,QStandardPaths
    from PySide6.QtNetwork import QLocalSocket
    app=QCoreApplication.instance() or QCoreApplication(['super-md'])
    app.setApplicationName('super-md');app.setOrganizationName('SuperMD')
    root=Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))
    name='supermd-qt-'+hashlib.sha256(str(root).encode()).hexdigest()[:20]
    def request(action):
        socket=QLocalSocket();socket.connectToServer(name)
        if not socket.waitForConnected(400):return False
        socket.write(json.dumps({'service':action}).encode()+b'\n');socket.waitForBytesWritten(500)
        okay=socket.waitForReadyRead(1000) and bytes(socket.readAll())==b'ok\n';socket.disconnectFromServer();return okay
    action='quit' if args.action=='stop' else args.action
    running=request(action)
    if args.action=='start' and not running:
        root.mkdir(parents=True,exist_ok=True)
        command=[sys.executable,'--background','--agent-access'] if getattr(sys,'frozen',False) else [sys.executable,str(Path(__file__).with_name('main.py')),'--background','--agent-access']
        with (root/'background-service.log').open('ab') as log:
            subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=os.name!='nt',creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name=='nt' else 0)
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            if request('status'):running=True;break
            time.sleep(.2)
        if not running:raise ValueError('Background service did not start; inspect its local log')
    result={'running':running,'action':args.action}
    if args.action=='stop':result['quitRequested']=running
    if running and args.action=='start':result['sessionsDirectory']=str(root/'qt-studio'/'agent-sessions')
    print(json.dumps({'ok':True,'result':result}));return 0
