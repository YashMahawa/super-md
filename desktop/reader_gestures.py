import sys

if __package__:
    from .ui import reader_gestures as _module
else:
    import ui.reader_gestures as _module

sys.modules[__name__] = _module
