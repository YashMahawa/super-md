"""Bounded theme data, validated by the same engine as Android."""
import json
import copy
import re
import subprocess
from pathlib import Path
from material_color_utilities import get_contrast_ratio
MAX_THEME = 2 * 1024 * 1024

BUNDLED_PRESETS = (
    ("apricot-glow", "Apricot glow"),
    ("avengers-assembly", "Avengers Assembly"),
    ("avengers-ink", "Avengers Ink"),
    ("blueprint", "Blueprint"),
    ("catnap-paws", "Catnap paws"),
    ("copper-grid", "Copper grid"),
    ("doctor-doom", "Doctor Doom"),
    ("gotham-midnight", "Gotham Midnight"),
    ("ink-dots", "Ink dots"),
    ("iron-man-reactor", "Iron Man Reactor"),
    ("lazy-sunday-cats", "Lazy Sunday cats"),
    ("midnight-paws", "Midnight paws"),
    ("plum-linen", "Plum linen"),
    ("rose-paper", "Rose paper"),
    ("spider-city", "Spider City"),
    ("study-desk", "Study desk"),
)
_PRESET_ID_RE = re.compile(r"^[a-z0-9-]+$")

TEMPLATE = {"format":"supermd-theme","version":1,"name":"My theme","accent":"violet","variants":{"light":{"colors":{},"background":{"pattern":"dots","color":"#7255a5","opacity":0.05,"spacing":24,"angle":0}},"dark":{"colors":{},"background":{"pattern":"dots","color":"#d4bbfc","opacity":0.04,"spacing":24,"angle":0}}},"metrics":{"controlRadius":22,"contentRadius":16,"paragraphSpacing":1.2,"codePadding":18,"headingWeight":700,"headingTracking":-0.02,"textTracking":0,"tableBorderWidth":1}}

def bundled_themes_dir(root=None):
    base = Path(root) if root else Path(__file__).resolve().parent.parent
    for candidate in (base / "dist" / "themes", base / "public" / "themes"):
        if candidate.is_dir() and any(candidate.glob("*.supermd-theme.json")):
            return candidate
    return base / "dist" / "themes"

def bundled_themes(root=None):
    directory = bundled_themes_dir(root)
    known = {preset_id: name for preset_id, name in BUNDLED_PRESETS}
    result = []
    for preset_id, name in BUNDLED_PRESETS:
        filename = f"{preset_id}.supermd-theme.json"
        if not directory.is_dir() or (directory / filename).is_file():
            result.append({"id": preset_id, "name": name, "filename": filename})
    if directory.is_dir():
        for path in sorted(directory.glob("*.supermd-theme.json")):
            preset_id = path.name[:-len(".supermd-theme.json")]
            if preset_id in known or not _PRESET_ID_RE.match(preset_id):
                continue
            try:
                raw_name = json.loads(path.read_text(encoding="utf-8-sig")).get("name")
                name = raw_name if isinstance(raw_name, str) and raw_name.strip() else preset_id.replace("-", " ").title()
            except (OSError, ValueError, TypeError):
                name = preset_id.replace("-", " ").title()
            result.append({"id": preset_id, "name": name, "filename": path.name})
    return result

def bundled_theme_path(preset_id, root=None):
    if not isinstance(preset_id, str) or not _PRESET_ID_RE.match(preset_id):
        raise ValueError("Unknown bundled theme")
    path = bundled_themes_dir(root) / f"{preset_id}.supermd-theme.json"
    if not path.is_file():
        raise ValueError(f"Bundled theme '{preset_id}' is missing")
    return path

def validate(engine, raw):
    if len(raw.encode("utf-8"))>MAX_THEME:raise ValueError("Theme exceeds 2 MB")
    result=subprocess.run([str(engine),"validate-theme"],input=raw,text=True,encoding="utf-8",capture_output=True,timeout=10,check=True,
        creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
    response=json.loads(result.stdout)
    if "error" in response:raise ValueError(response["error"])
    return response["theme"]

def read(engine,path):
    with path.open("rb") as stream:raw=stream.read(MAX_THEME+1)
    if len(raw)>MAX_THEME:raise ValueError("Theme exceeds 2 MB")
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

def artwork(theme, selected):
    result=copy.deepcopy(selected.get("artwork",{}))
    for item in result.values():
        image=item.get("image","")
        if image.startswith("asset:"):item["image"]=(theme or {}).get("assets",{}).get(image[6:],"")
    return result

def has_background_override(overrides):
    if not isinstance(overrides, dict):
        return False
    return (
        bool(overrides.get("patternKind"))
        or overrides.get("patternOpacity", -1) >= 0
        or overrides.get("patternSize", 0) > 0
        or overrides.get("patternSpacing", 0) > 0
    )

def reader(theme, mode, dark, overrides=None, resolve_assets=True):
    selected=variant(theme,mode,dark)
    source_background=selected.get("background")
    background=dict(source_background) if isinstance(source_background,dict) else None
    if theme and has_background_override(overrides):
        background=dict(background or {"pattern":"none","color":selected.get("colors",{}).get("primary","#82708e")})
        if overrides.get("patternKind"):background["pattern"]=overrides["patternKind"]
        for key,default in (("opacity",-1),("size",0),("spacing",0)):
            value=overrides.get("pattern"+key.title(),default)
            if value!=default:background[key]=value
    images=copy.deepcopy(selected.get("artwork",{}))
    if resolve_assets:
        # The reader does not need duplicate copies of native chrome assets.
        images=artwork(theme,{"artwork":{"reader":images["reader"]} if "reader" in images else {}})
    return {"colors":selected.get("colors",{}),"background":background,"artwork":images,"metrics":(theme or {}).get("metrics",{})}

def for_sharing(theme, overrides=None):
    return copy.deepcopy(theme or TEMPLATE)
