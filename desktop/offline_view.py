"""Bounded subprocess rendering for MCP calls from a non-GUI server thread."""
import hashlib,os,subprocess,sys,tempfile
from pathlib import Path

def render_offline(store,path_value,*,width=1200,expected_revision=None):
    path=store.resolve(path_value);raw=path.read_bytes();revision=hashlib.sha256(raw).hexdigest()
    if expected_revision and expected_revision!=revision:raise ValueError('Revision conflict; inspect the note again')
    with tempfile.TemporaryDirectory(prefix='supermd-preview-') as directory:
        target=Path(directory)/'preview.png'
        command=[sys.executable,'agent'] if getattr(sys,'frozen',False) else [sys.executable,str(Path(__file__).with_name('agent_cli.py'))]
        for root in store.roots:command+=['--root',str(root)]
        command+=['--root',directory,'preview',str(path),str(target),'--width',str(width)]
        result=subprocess.run(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=55)
        if result.returncode or not target.is_file():raise ValueError('Offline reader preview failed: '+result.stdout.decode(errors='replace')[-1000:])
        if path.read_bytes()!=raw:raise ValueError('The source changed while rendering; retry')
        return target.read_bytes()


def render_live_snapshot(content,assets,source_path,*,width=1200,heading=None,view=None):
    with tempfile.TemporaryDirectory(prefix='supermd-live-preview-') as directory:
        root=Path(directory);source=Path(source_path) if source_path else root/'Untitled.md'
        if not source_path:source.write_text('',encoding='utf-8')
        snapshot=root/'snapshot.json';snapshot.write_text(__import__('json').dumps({'content':content,'assets':assets,'view':view or {}}),encoding='utf-8')
        target=root/'preview.png'
        command=[sys.executable,'agent'] if getattr(sys,'frozen',False) else [sys.executable,str(Path(__file__).with_name('agent_cli.py'))]
        command+=['--root',str(source.parent),'--root',directory,'preview',str(source),str(target),'--snapshot',str(snapshot),'--width',str(max(320,width))]
        if heading:command+=['--heading',heading]
        result=subprocess.run(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=55)
        if result.returncode or not target.exists():raise ValueError('Background preview failed: '+result.stdout.decode(errors='replace')[-1000:])
        return target.read_bytes()
