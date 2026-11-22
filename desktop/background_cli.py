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
        if not socket.waitForConnected(1000):return None
        socket.write(json.dumps({'service':action}).encode('utf-8')+b'\n');socket.waitForBytesWritten(1000)
        raw=bytes(socket.readAll())
        while b'\n' not in raw and socket.waitForReadyRead(2000):
            raw+=bytes(socket.readAll())
        if b'\n' not in raw:
            raw+=bytes(socket.readAll())
        socket.disconnectFromServer()
        if not raw:
            raise ValueError('Existing Super MD instance did not respond to service request')
        try:
            reply=json.loads(raw.split(b'\n',1)[0].decode('utf-8'))
        except (UnicodeDecodeError,ValueError) as error:
            raise ValueError('Invalid response from Super MD instance') from error
        if not isinstance(reply,dict):
            raise ValueError('Invalid response from Super MD instance')
        return reply

    reply=request(args.action)
    if args.action=='status':
        if reply is None:
            running=False
        else:
            if not reply.get('ok',False):
                raise ValueError(reply.get('error') or 'Failed to query background service status')
            running=bool(reply.get('running',False))
        result={'running':running,'action':'status'}
        if reply is not None and 'agentAccess' in reply:
            result['agentAccess']=bool(reply['agentAccess'])
        print(json.dumps({'ok':True,'result':result}));return 0

    if args.action=='stop':
        if reply is None:
            result={'running':False,'action':'stop','quitRequested':False}
        else:
            if not reply.get('ok',False):
                raise ValueError(reply.get('error') or 'Failed to stop background service')
            result={
                'running':bool(reply.get('running',False)),
                'action':'stop',
                'quitRequested':bool(reply.get('quitRequested',False)),
            }
        print(json.dumps({'ok':True,'result':result}));return 0

    sessions_dir=str(root/'qt-studio'/'agent-sessions')
    if reply is not None:
        if not reply.get('ok',False):
            raise ValueError(reply.get('error') or 'Super MD refused to start background agent access')
        running=bool(reply.get('running',True))
        if reply.get('sessionsDirectory'):
            sessions_dir=str(reply['sessionsDirectory'])
    else:
        running=False
        root.mkdir(parents=True,exist_ok=True)
        command=[sys.executable,'--background','--agent-access'] if getattr(sys,'frozen',False) else [sys.executable,str(Path(__file__).with_name('main.py')),'--background','--agent-access']
        with (root/'background-service.log').open('ab') as log:
            subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=os.name!='nt',creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name=='nt' else 0)
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            status_reply=request('status')
            if status_reply is not None:
                if not status_reply.get('ok',False):
                    raise ValueError(status_reply.get('error') or 'Background service failed to start')
                if status_reply.get('running'):
                    running=True
                    break
            time.sleep(.2)
        if not running:raise ValueError('Background service did not start; inspect its local log')
    result={'running':running,'action':'start'}
    if running:result['sessionsDirectory']=sessions_dir
    print(json.dumps({'ok':True,'result':result}));return 0
