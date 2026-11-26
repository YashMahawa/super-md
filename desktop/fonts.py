import sys

if __package__:
    from .ui import fonts as _module
else:
    import ui.fonts as _module

sys.modules[__name__] = _module
