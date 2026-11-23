"""Control the per-user application service over its private local socket."""
import argparse,hashlib,json,os,subprocess,sys,time
from pathlib import Path

def _daemon_command(*,executable=None,frozen=None,platform=None,env=None):
    frozen=getattr(sys,'frozen',False) if frozen is None else bool(frozen)
    platform=sys.platform if platform is None else platform
    env=os.environ if env is None else env
    exe=Path(os.path.abspath(Path(executable or sys.executable).expanduser()))
    if frozen:
        exe=exe.resolve()
        if platform.startswith('win'):
            gui=exe.with_name('super-md.exe')
            if gui.is_file():exe=gui.resolve()
        elif platform.startswith('linux'):
            appimage,appdir=env.get('APPIMAGE',''),env.get('APPDIR','')
            if appimage and appdir and exe.is_relative_to(Path(appdir).resolve()):
                candidate=Path(appimage).expanduser()
                if candidate.is_file():exe=candidate.resolve()
        return [str(exe),'--background','--agent-access']
    if platform.startswith('win'):
        windowed=exe.with_name('pythonw.exe')
        if windowed.is_file():exe=windowed
    return [str(exe),str(Path(__file__).with_name('main.py')),'--background','--agent-access']

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
        while b'\n' not in raw and socket.waitForReadyRead(2000):raw+=bytes(socket.readAll())
        if b'\n' not in raw:raw+=bytes(socket.readAll())
        socket.disconnectFromServer()
        if not raw:
            if socket.state()==QLocalSocket.LocalSocketState.UnconnectedState:return None
            raise ValueError('Existing Super MD instance did not respond to service request')
        try:reply=json.loads(raw.split(b'\n',1)[0].decode('utf-8'))
        except (UnicodeDecodeError,ValueError) as error:raise ValueError('Invalid response from Super MD instance') from error
        if not isinstance(reply,dict):raise ValueError('Invalid response from Super MD instance')
        return reply
    reply=request(args.action)
    if args.action=='status':
        if reply is not None and not reply.get('ok',False):raise ValueError(reply.get('error') or 'Failed to query background service status')
        result={'running':bool(reply and reply.get('running')),'action':'status'}
        if reply is not None and 'agentAccess' in reply:result['agentAccess']=bool(reply['agentAccess'])
        print(json.dumps({'ok':True,'result':result}));return 0
    if args.action=='stop':
        if reply is not None and not reply.get('ok',False):raise ValueError(reply.get('error') or 'Failed to stop background service')
        result={'running':bool(reply and reply.get('running')),'action':'stop','quitRequested':bool(reply and reply.get('quitRequested'))}
        print(json.dumps({'ok':True,'result':result}));return 0
    sessions_dir=str(root/'qt-studio'/'agent-sessions')
    if reply is not None:
        if not reply.get('ok',False):raise ValueError(reply.get('error') or 'Super MD refused to start background agent access')
        running=bool(reply.get('running',True))
        if reply.get('sessionsDirectory'):sessions_dir=str(reply['sessionsDirectory'])
    else:
        running=False;root.mkdir(parents=True,exist_ok=True)
        flags=(subprocess.CREATE_NEW_PROCESS_GROUP|getattr(subprocess,'CREATE_NO_WINDOW',0)) if os.name=='nt' else 0
        with (root/'background-service.log').open('ab') as log:
            subprocess.Popen(_daemon_command(),stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=os.name!='nt',creationflags=flags)
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            status=request('status')
            if status is not None:
                if not status.get('ok',False):raise ValueError(status.get('error') or 'Background service failed to start')
                if status.get('running'):running=True;break
            time.sleep(.2)
        if not running:raise ValueError('Background service did not start; inspect its local log')
    result={'running':running,'action':args.action}
    if running:result['sessionsDirectory']=sessions_dir
    print(json.dumps({'ok':True,'result':result}));return 0
