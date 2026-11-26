import sys

if __package__:
    from .ui import shortcuts as _module
else:
    import ui.shortcuts as _module

sys.modules[__name__] = _module
