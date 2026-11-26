import sys

if __package__:
    from .ui import theme as _module
else:
    import ui.theme as _module

sys.modules[__name__] = _module
