"""Bounded, event-triggered reconciliation. No timers or recursive scans."""
import os
from pathlib import Path

def identity(path):
    try:
        value=Path(path).stat()
        return (value.st_dev,value.st_ino) if value.st_ino else None
    except OSError:return None

def reconcile(known, changed):
    updates={}; missing={}
    for path,previous in known.items():
        if path not in changed and str(Path(path).parent) not in changed:continue
        try:Path(path).stat()
        except FileNotFoundError:missing[path]=previous
        except OSError:continue  # Permission/provider failures are not deletion.
    by_parent={str(Path(path).parent) for path in missing}
    for parent in by_parent:
        candidates={path:value for path,value in missing.items() if str(Path(path).parent)==parent}
        remaining={value for value in candidates.values() if value}
        found={};complete=True
        try:
            with os.scandir(parent) as entries:
                for count,entry in enumerate(entries):
                    if count>=10000:complete=False;break
                    if not remaining:break
                    try:
                        stat=entry.stat(follow_symlinks=False);key=(stat.st_dev,stat.st_ino)
                    except OSError:continue
                    if key in remaining:found[key]=str(Path(entry.path).absolute());remaining.remove(key)
        except FileNotFoundError:pass
        except OSError:continue
        for path,previous in candidates.items():
            if previous in found:updates[path]=found[previous]
            elif complete:updates[path]=None
    return updates
