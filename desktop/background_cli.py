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
    from PySide6.QtCore import QCoreApplication,QLockFile,QStandardPaths
    from PySide6.QtNetwork import QLocalSocket
    app=QCoreApplication.instance() or QCoreApplication(['super-md'])
    app.setApplicationName('super-md');app.setOrganizationName('SuperMD')
    root=Path(QStandardPaths.writableLocation(QStandardPaths.AppDataLocation))
    name='supermd-qt-'+hashlib.sha256(str(root).encode()).hexdigest()[:20]
    def _instance_lock_held():
        if not root.exists():return False
        probe=QLockFile(str(root/'native-instance.lock'));probe.setStaleLockTime(0)
        if probe.tryLock(0):
            probe.unlock();return False
        return True
    def _process_exit_clear():
        try:
            from .instance import is_process_exit_clear
        except ImportError:
            from instance import is_process_exit_clear
        return is_process_exit_clear(root)
    def request(action,*,startup_poll=False):
        wire_action='quit' if action=='stop' else action
        socket=QLocalSocket();socket.connectToServer(name)
        if not socket.waitForConnected(1000):return None
        socket.write(json.dumps({'service':wire_action}).encode('utf-8')+b'\n');socket.waitForBytesWritten(1000)
        raw=bytes(socket.readAll())
        while b'\n' not in raw and socket.waitForReadyRead(2000):raw+=bytes(socket.readAll())
        if b'\n' not in raw:raw+=bytes(socket.readAll())
        if not raw and socket.state()==QLocalSocket.LocalSocketState.ConnectedState:
            socket.waitForDisconnected(50)
        peer_closed=(
            socket.state() in (QLocalSocket.LocalSocketState.UnconnectedState,QLocalSocket.LocalSocketState.ClosingState)
            or socket.error() in (
                QLocalSocket.LocalSocketError.PeerClosedError,
                QLocalSocket.LocalSocketError.ConnectionError,
                QLocalSocket.LocalSocketError.ServerNotFoundError,
                QLocalSocket.LocalSocketError.ConnectionRefusedError,
            )
        )
        socket.disconnectFromServer()
        socket.close()
        if not raw:
            if peer_closed or startup_poll:return None
            probe=QLocalSocket();probe.connectToServer(name)
            still_listening=probe.waitForConnected(100)
            probe.abort();probe.close()
            if not still_listening and not _instance_lock_held():return None
            raise ValueError('Existing Super MD instance did not respond to service request')
        line=raw.split(b'\n',1)[0].rstrip(b'\r')
        if line==b'ok':
            if action=='status':return {'ok':True,'running':True}
            if action=='stop':return {'ok':True,'running':False,'quitRequested':True}
            return {'ok':True,'running':True,'sessionsDirectory':str(root/'qt-studio'/'agent-sessions')}
        try:reply=json.loads(line.decode('utf-8'))
        except (UnicodeDecodeError,ValueError) as error:raise ValueError('Invalid response from Super MD instance') from error
        if not isinstance(reply,dict):raise ValueError('Invalid response from Super MD instance')
        return reply
    if args.action=='start':
        try:reply=request('start')
        except ValueError as error:
            if 'Invalid response' in str(error):raise
            if not _instance_lock_held():
                probe=QLocalSocket();probe.connectToServer(name)
                still_listening=probe.waitForConnected(100)
                probe.abort();probe.close()
                if still_listening:raise
                reply=None
            else:
                reply=None;init_deadline=time.monotonic()+8
                while time.monotonic()<init_deadline:
                    reply=request('start',startup_poll=True)
                    if reply is not None or not _instance_lock_held():break
                    time.sleep(.1)
                if reply is None and _instance_lock_held():
                    reply=request('start')
    else:
        reply=request(args.action)
    if args.action=='status':
        if reply is not None and not reply.get('ok',False):
            if reply.get('error')=='Background service is unavailable':reply=None
            else:raise ValueError(reply.get('error') or 'Failed to query background service status')
        result={'running':bool(reply and reply.get('running')),'action':'status'}
        if reply is not None and 'agentAccess' in reply:result['agentAccess']=bool(reply['agentAccess'])
        print(json.dumps({'ok':True,'result':result}));return 0
    if args.action=='stop':
        if reply is not None and not reply.get('ok',False):
            if reply.get('error')=='Background service is unavailable':reply=None
            else:raise ValueError(reply.get('error') or 'Failed to stop background service')
        result={'running':bool(reply and reply.get('running')),'action':'stop','quitRequested':bool(reply and reply.get('quitRequested'))}
        print(json.dumps({'ok':True,'result':result}));return 0
    sessions_dir=str(root/'qt-studio'/'agent-sessions')
    if reply is not None and not reply.get('ok',False) and reply.get('error')=='Background service is unavailable':
        wait_deadline=time.monotonic()+5
        while time.monotonic()<wait_deadline and (reply is None or (not reply.get('ok',False) and reply.get('error')=='Background service is unavailable')):
            time.sleep(.05);reply=request('start',startup_poll=True)
    if reply is not None and reply.get('stopping'):
        stop_deadline=time.monotonic()+15
        while time.monotonic()<stop_deadline:
            status=request('status',startup_poll=True)
            if status is None:reply=None;break
            if not status.get('stopping') and status.get('running'):
                reply=request('start',startup_poll=True);break
            time.sleep(.05)
        if reply is not None and reply.get('stopping'):
            raise ValueError(reply.get('error') or 'Super MD is currently quitting; finish closing it before starting the background service.')
    if reply is not None:
        if not reply.get('ok',False):raise ValueError(reply.get('error') or 'Super MD refused to start background agent access')
        running=bool(reply.get('running',True))
        if reply.get('sessionsDirectory'):sessions_dir=str(reply['sessionsDirectory'])
    else:
        running=False;root.mkdir(parents=True,exist_ok=True)
        lock_probe=QLockFile(str(root/'native-instance.lock'));lock_probe.setStaleLockTime(0)
        lock_deadline=time.monotonic()+15;lock_cleared=False
        while time.monotonic()<lock_deadline:
            if lock_probe.tryLock(100):
                lock_probe.unlock()
                if _process_exit_clear():
                    lock_cleared=True;break
                time.sleep(.05);continue
            probe=request('status',startup_poll=True)
            if probe is not None and probe.get('ok',False) and probe.get('running'):
                running=True;break
        if not running and not lock_cleared:
            raise ValueError('Previous Super MD instance did not finish shutting down in time')
        proc=None
        if not running:
            flags=(subprocess.CREATE_NEW_PROCESS_GROUP|getattr(subprocess,'CREATE_NO_WINDOW',0)) if os.name=='nt' else 0
            with (root/'background-service.log').open('ab') as log:
                proc=subprocess.Popen(_daemon_command(),stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=os.name!='nt',creationflags=flags)
            deadline=time.monotonic()+30
            while time.monotonic()<deadline:
                status=request('status',startup_poll=True)
                if status is not None:
                    if status.get('ok',False):
                        if status.get('running'):running=True;break
                    elif status.get('error')!='Background service is unavailable':
                        raise ValueError(status.get('error') or 'Background service failed to start')
                if proc is not None:
                    exit_code=proc.poll()
                    if type(exit_code) is int:
                        status=request('status',startup_poll=True)
                        if status is not None and status.get('ok',False) and status.get('running'):
                            running=True
                        break
                time.sleep(.2)
        if not running:raise ValueError('Background service did not start; inspect its local log')
    result={'running':running,'action':args.action}
    if running:result['sessionsDirectory']=sessions_dir
    print(json.dumps({'ok':True,'result':result}));return 0
