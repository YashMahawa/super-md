import sys

if __package__:
    from .ui import native_frame as _module
else:
    import ui.native_frame as _module

sys.modules[__name__] = _module
