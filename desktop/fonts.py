"""Bounded, private font imports shared by the reader and native typesetter."""
import base64
import hashlib
import json
import re
from pathlib import Path
from PySide6.QtGui import QFontDatabase
from documents import atomic_write

class FontStore:
    def __init__(self, data):
        self.directory = Path(data)/"fonts"
        self.directory.mkdir(exist_ok=True)
        self.families = {}
        try:
            records = json.loads((self.directory/"index.json").read_text(encoding="utf-8"))
            for filename in records[:32]:
                if isinstance(filename,str) and re.fullmatch(r"[0-9a-f]{64}\.(ttf|otf)",filename): self._register(self.directory/filename)
        except (OSError,ValueError,TypeError): pass

    def _register(self,path):
        if not path.is_file() or not 0 < path.stat().st_size <= 20_000_000: return []
        font_id = QFontDatabase.addApplicationFont(str(path))
        names = list(QFontDatabase.applicationFontFamilies(font_id)) if font_id >= 0 else []
        for family in names:
            files = self.families.setdefault(family,[])
            if path not in files: files.append(path)
        return names

    def import_file(self,path):
        path = Path(path)
        if path.suffix.lower() not in (".ttf",".otf") or not 0 < path.stat().st_size <= 20_000_000:
            raise ValueError("Choose a TrueType or OpenType font under 20 MB.")
        records = sorted({p for files in self.families.values() for p in files})
        data=path.read_bytes(); target=self.directory/(hashlib.sha256(data).hexdigest()+path.suffix.lower())
        if target not in records and (len(records)>=32 or sum(p.stat().st_size for p in records)+len(data)>64_000_000):
            raise ValueError("The font library limit is 32 files or 64 MB.")
        font_id=QFontDatabase.addApplicationFontFromData(data)
        names=list(QFontDatabase.applicationFontFamilies(font_id)) if font_id>=0 else []
        if not names: raise ValueError("This file could not be read as a font.")
        atomic_write(target,data)
        for family in names:
            files=self.families.setdefault(family,[])
            if target not in files: files.append(target)
        atomic_write(self.directory/"index.json",json.dumps(sorted({p.name for files in self.families.values() for p in files})).encode())
        return names[0]

    def reader(self,family):
        files=self.families.get(family)
        if not files: raise ValueError("That imported font is unavailable.")
        return {"family":family,"data":"data:font/ttf;base64,"+base64.b64encode(files[0].read_bytes()).decode()}

    def pdf_assets(self,family):
        return {"__font_"+p.name:base64.b64encode(p.read_bytes()).decode() for p in self.families.get(family,[])}
