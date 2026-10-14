"""Bounded, event-triggered reconciliation. No timers or recursive scans."""
import os
from pathlib import Path

def identity(path):
    try:
        value=Path(path).stat()
        return (value.st_dev,value.st_ino) if value.st_ino else None
    except OSError:return None

def reconcile(known, changed):
    updates={}; missing={};case_candidates={}
    for path,previous in known.items():
        if path not in changed and str(Path(path).parent) not in changed:continue
        try:
            Path(path).stat()
            if str(Path(path).parent) in changed:case_candidates[path]=previous
        except FileNotFoundError:missing[path]=previous
        except OSError:continue  # Permission/provider failures are not deletion.
    by_parent={str(Path(path).parent) for path in missing|case_candidates}
    for parent in by_parent:
        candidates={path:value for path,value in missing.items() if str(Path(path).parent)==parent}
        case_names={Path(path).name.casefold():(path,key) for path,key in case_candidates.items() if str(Path(path).parent)==parent}
        has_case_candidates=bool(case_names);seen_names=set();case_updates={}
        remaining={value for value in candidates.values() if value}
        found={};complete=True
        try:
            with os.scandir(parent) as entries:
                for count,entry in enumerate(entries):
                    if count>=10000:complete=False;break
                    seen_names.add(entry.name)
                    if not remaining and not case_names and not has_case_candidates:break
                    if not remaining and entry.name.casefold() not in case_names:continue
                    try:
                        # DirEntry.stat reports zero file IDs on Windows. A
                        # fresh path stat opens the file metadata and supplies
                        # the same stable identity used for watched documents.
                        stat=Path(entry.path).stat() if os.name=="nt" else entry.stat(follow_symlinks=False)
                        key=(stat.st_dev,stat.st_ino)
                    except OSError:continue
                    if key in remaining:found[key]=str(Path(entry.path).absolute());remaining.remove(key)
                    old=case_names.pop(entry.name.casefold(),None)
                    if old and old[1]==key and Path(old[0]).name!=entry.name:case_updates[old[0]]=str(Path(entry.path).absolute())
        except FileNotFoundError:pass
        except OSError:continue
        if complete:
            updates.update({old:new for old,new in case_updates.items() if Path(old).name not in seen_names})
        for path,previous in candidates.items():
            if previous in found:updates[path]=found[previous]
            elif complete:updates[path]=None
    return updates
