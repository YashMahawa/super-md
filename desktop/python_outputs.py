"""Private derived-output disk storage, not note assets or executable code."""
import hashlib
import json
from pathlib import Path
from documents import atomic_json, image_data

class PythonOutputs:
    def __init__(self,root:Path):self.root=root
    def _path(self,source:str):
        if not isinstance(source,str) or len(source)>2_000_000:raise ValueError("Python source is too large")
        return self.root/(hashlib.sha256(source.encode()).hexdigest()+".json")
    def store(self,source:str,result:dict):
        if not isinstance(result,dict) or set(result)!={"stdout","stderr","images","ok"} or not isinstance(result["ok"],bool):raise ValueError("Invalid Python output")
        if any(not isinstance(result[key],str) or len(result[key])>2_000_000 for key in ("stdout","stderr")):raise ValueError("Python text output is too large")
        if not isinstance(result["images"],list) or len(result["images"])>20:raise ValueError("Too many Python figures")
        total=0
        for image in result["images"]:
            _,decoded=image_data(image);total+=len(decoded)
            if total>75_000_000:raise ValueError("Python figures exceed 75 MB")
        path=self._path(source);self.root.mkdir(parents=True,exist_ok=True);atomic_json(path,result)
    def load(self,source:str):
        path=self._path(source)
        if not path.exists():return None
        if path.stat().st_size>110_000_000:raise ValueError("Cached Python output is too large")
        with path.open(encoding="utf-8") as file:return json.load(file)
