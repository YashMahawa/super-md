import sys

if __package__:
    from .ui import reader_edits as _module
else:
    import ui.reader_edits as _module

sys.modules[__name__] = _module
