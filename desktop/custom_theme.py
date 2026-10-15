"""Bounded theme data, validated by the same engine as Android."""
import json
import subprocess
from material_color_utilities import get_contrast_ratio

TEMPLATE = {"format":"supermd-theme","version":1,"name":"My theme","accent":"violet","variants":{"light":{"colors":{},"background":{"pattern":"dots","color":"#7255a5","opacity":0.05,"spacing":24,"angle":0}},"dark":{"colors":{},"background":{"pattern":"dots","color":"#d4bbfc","opacity":0.04,"spacing":24,"angle":0}}},"metrics":{"controlRadius":22,"contentRadius":16,"paragraphSpacing":1.2,"codePadding":18,"headingWeight":700,"headingTracking":-0.02,"textTracking":0,"tableBorderWidth":1}}

def validate(engine, raw):
    if len(raw.encode("utf-8"))>65536:raise ValueError("Theme exceeds 64 KB")
    result=subprocess.run([str(engine),"validate-theme"],input=raw,text=True,encoding="utf-8",capture_output=True,timeout=10,check=True,
        creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
    response=json.loads(result.stdout)
    if "error" in response:raise ValueError(response["error"])
    return response["theme"]

def read(engine,path):
    with path.open("rb") as stream:raw=stream.read(65537)
    if len(raw)>65536:raise ValueError("Theme exceeds 64 KB")
    return validate(engine,raw.decode("utf-8-sig"))

def stamp(path):
    try:
        value=path.stat()
        return (str(path),value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns)
    except OSError:return (str(path),None)

def variant(theme, mode, dark):
    return (theme or {}).get("variants",{}).get("black" if mode=="black" else "dark" if dark else "light",{})

def palette(base, custom):
    overrides={key:value for key,value in custom.items() if key in base}
    if not overrides:return dict(base)
    result={**base,**overrides}
    surfaces=("surface","surface-low","surface-high")
    if max(min(get_contrast_ratio(c,result[b]) for b in surfaces) for c in ("#111111","#f9f9f9"))<4.5:
        result["surface-low"]=result["surface-high"]=result["surface"]
    if get_contrast_ratio(result["primary"],result["surface"])<4.5 or any(get_contrast_ratio(result["primary"],result[b])<3 for b in surfaces):
        result["primary"]=max(("#111111","#f9f9f9"),key=lambda c:min(get_contrast_ratio(c,result[b]) for b in surfaces))
    for foreground,backgrounds in [("text",["surface","surface-low","surface-high"]),("muted",["surface","surface-low","surface-high"]),("on-primary",["primary"]),("on-primary-container",["primary-container"])]:
        if any(get_contrast_ratio(result[foreground],result[background])<4.5 for background in backgrounds):
            result[foreground]=max(("#111111","#f9f9f9"),key=lambda c:min(get_contrast_ratio(c,result[b]) for b in backgrounds))
    result["on-surface"]=result["text"]
    return result

def reader(theme, mode, dark):
    selected=variant(theme,mode,dark)
    return {"colors":selected.get("colors",{}),"background":selected.get("background"),"metrics":(theme or {}).get("metrics",{})}
