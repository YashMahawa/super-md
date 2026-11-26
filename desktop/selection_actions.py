import sys

if __package__:
    from .ui import selection_actions as _module
else:
    import ui.selection_actions as _module

sys.modules[__name__] = _module
