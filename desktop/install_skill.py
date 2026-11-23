"""Install the complete bundled authoring skill, with reversible replacement."""
import argparse,json,os,shutil,sys,uuid
from pathlib import Path

def main(argv):
    p=argparse.ArgumentParser(description='Install the complete Super MD skill')
    default=Path(os.environ.get('CODEX_HOME',str(Path.home()/'.codex')))/'skills'/'super-md'
    p.add_argument('--destination',type=Path,default=default);p.add_argument('--replace',action='store_true');args=p.parse_args(argv)
    root=Path(sys._MEIPASS)/'resources' if getattr(sys,'frozen',False) else Path(__file__).resolve().parent.parent
    source=root/'dist/super-md-skill'
    if not source.is_dir():source=root/'docs/skills/super-md'
    for relative in ['SKILL.md','references/study-notes.md','references/visual-authoring.md','references/agent-connection.md','assets/study-visual-example.svg']:
        if not (source/relative).is_file():raise ValueError('The complete skill is missing from this installation')
    dest=args.destination.expanduser().absolute();backup=None
    if dest.is_symlink():raise ValueError('Choose a real skill directory, not a symlink')
    if dest.exists():
        if not args.replace:raise ValueError('Skill directory exists; use --replace to back it up and update it')
        backup=dest.with_name(dest.name+'.backup-'+uuid.uuid4().hex[:8]);dest.rename(backup)
    try:
        dest.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(source,dest)
        if backup and (backup/'references/local-preferences.md').is_file():
            shutil.copyfile(backup/'references/local-preferences.md',dest/'references/local-preferences.md')
    except Exception:
        if dest.exists():shutil.rmtree(dest)
        if backup:backup.rename(dest)
        raise
    print(json.dumps({'ok':True,'result':{'installed':str(dest),'backup':str(backup) if backup else None,'completePackage':True}}));return 0
