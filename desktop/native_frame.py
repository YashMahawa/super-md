"""Native window frame colors. Windows draws caption buttons over the expanded
client area; without the dark-mode attribute they stay black on a dark app."""
from __future__ import annotations
import sys

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36

def _colorref(value: str) -> int:
    value = value.lstrip("#")
    red, green, blue = int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    return red | green << 8 | blue << 16

def apply(window, dark: bool, colors: dict) -> bool:
    if sys.platform != "win32":
        return False
    try:
        import ctypes
        from ctypes import wintypes
        handle = wintypes.HWND(int(window.winId()))
        dwm = ctypes.windll.dwmapi
        def set_attribute(attribute: int, value: int):
            data = ctypes.c_int(value)
            dwm.DwmSetWindowAttribute(handle, attribute, ctypes.byref(data), ctypes.sizeof(data))
        set_attribute(DWMWA_USE_IMMERSIVE_DARK_MODE, 1 if dark else 0)
        # Windows 11 only; older builds ignore unknown attributes.
        set_attribute(DWMWA_CAPTION_COLOR, _colorref(colors["surface-low"]))
        set_attribute(DWMWA_TEXT_COLOR, _colorref(colors["text"]))
        set_attribute(DWMWA_BORDER_COLOR, _colorref(colors["outline"]))
        return True
    except (OSError, AttributeError, ValueError, KeyError):
        return False
