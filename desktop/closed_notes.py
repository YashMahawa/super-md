import sys

if __package__:
    from .core import closed_notes as _module
else:
    import core.closed_notes as _module
sys.modules[__name__] = _module
