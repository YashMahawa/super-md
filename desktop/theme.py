"""Material semantic roles with real system detection and contrast enforcement."""
import json
import os
import re
import subprocess
import sys
from functools import lru_cache
from pathlib import Path
from material_color_utilities import Variant, get_contrast_ratio, theme_from_color

def normalize_color(value):
    if isinstance(value,str) and re.fullmatch(r"#?[a-fA-F0-9]{6}",value):
        return "#"+value.removeprefix("#").lower()
    return None

def blend(base, tint, amount):
    a, b = base.lstrip("#"), tint.lstrip("#")
    return "#" + "".join(f"{round(int(a[i:i+2],16)*(1-amount)+int(b[i:i+2],16)*amount):02x}" for i in (0,2,4))

def system_palette_paths():
    # Optional providers, never application branding or a prerequisite on other distros.
    configured = os.environ.get("SUPERMD_SYSTEM_PALETTE")
    return [Path(configured)] if configured else [Path(os.environ.get("XDG_STATE_HOME",Path.home()/".local/state"))/"caelestia/scheme.json"]

def read_system_palette():
    for path in system_palette_paths():
        try:
            if path.stat().st_size > 100_000: continue
            data = json.loads(path.read_text())
            colors = {key:value for key,raw in data.get("colours",data.get("colors",{})).items() if (value:=normalize_color(raw))}
            if colors: return data.get("mode"),colors
        except (OSError,ValueError,TypeError,AttributeError):
            pass
    return None,{}

def detect_system_dark(qt_scheme):
    if qt_scheme in ("Dark","Light"):
        return qt_scheme == "Dark"
    if sys.platform == "win32":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
                return winreg.QueryValueEx(key,"AppsUseLightTheme")[0] == 0
        except OSError: pass
    commands = [["defaults","read","-g","AppleInterfaceStyle"]] if sys.platform == "darwin" else [["gsettings","get","org.gnome.desktop.interface","color-scheme"],["gsettings","get","org.gnome.desktop.interface","gtk-theme"]]
    for command in commands:
        try:
            result = subprocess.run(command,capture_output=True,text=True,timeout=1)
            value = result.stdout.strip().lower()
            if result.returncode == 0:
                if "dark" in value: return True
                if "light" in value: return False
        except (OSError,subprocess.TimeoutExpired): pass
    if sys.platform == "darwin":
        # AppleInterfaceStyle is absent for macOS's ordinary light appearance.
        return False
    mode,_ = read_system_palette()
    return mode == "dark" if mode in ("light","dark") else None

@lru_cache(maxsize=12)
def generated(seed,dark):
    # Maintained Python bindings around Google's Material Color Utilities C++.
    theme = theme_from_color(seed,0,Variant.TONALSPOT)
    return (theme.schemes.dark if dark else theme.schemes.light).dict()

def tokens(mode,system_dark,system_colors=None,system_mode=None):
    colors = system_colors or {}
    dark = mode in ("dark","black") or mode == "system" and system_dark is not False
    seed = colors.get("primary_paletteKeyColor",colors.get("primary", "#386aaf"))
    scheme = generated(seed,dark)
    roles = {"primary":"primary","on-primary":"on_primary","surface":"surface","surface-low":"surface_container_low","surface-high":"surface_container_high","text":"on_surface","muted":"on_surface_variant","outline":"outline_variant","primary-container":"primary_container","on-primary-container":"on_primary_container"}
    result = {key:scheme[role] for key,role in roles.items()}
    if mode == "system" and system_mode == ("dark" if dark else "light"):
        names = {"primary":"primary","on-primary":"onPrimary","surface":"surface","surface-low":"surfaceContainerLow","surface-high":"surfaceContainerHigh","text":"onSurface","muted":"onSurfaceVariant","outline":"outlineVariant","primary-container":"primaryContainer","on-primary-container":"onPrimaryContainer"}
        result.update({key:colors[name] for key,name in names.items() if name in colors})
    if mode == "black":
        result.update({"surface":"#080808","surface-low":"#101010","surface-high":"#1c1c1c"})
    if not dark:
        # A tinted paper hierarchy, not a stark white sheet over dark outlines.
        # Keep the actual system accent when available; otherwise use app blue.
        result["surface"] = blend(blend(result["surface"], result["primary-container"], .9),result["primary"],.035)
        result["surface-low"] = blend(blend(result["surface-low"], result["primary-container"], .75),result["primary"],.07)
        result["surface-high"] = blend(blend(result["surface-high"], result["primary-container"], .7),result["primary"],.16)
        result["text"] = blend(result["text"], result["surface"], .08)
        result["outline"] = blend(result["outline"], result["text"], .24)
    if any(get_contrast_ratio(result["primary"],result[background]) < 4.5 for background in ("surface","surface-low","surface-high")):
        result["primary"] = scheme["primary"]
        result["on-primary"] = scheme["on_primary"]
    # System palettes may be customized beyond Material's contrast guarantees.
    for foreground,backgrounds in [("text",["surface","surface-low","surface-high"]),("muted",["surface","surface-low","surface-high"]),("on-primary",["primary"]),("on-primary-container",["primary-container"])]:
        if any(get_contrast_ratio(result[foreground],result[background]) < 4.5 for background in backgrounds):
            result[foreground] = max(("#111111","#f9f9f9"),key=lambda color:min(get_contrast_ratio(color,result[b]) for b in backgrounds))
    result["on-surface"] = result["text"]
    return dark,result
