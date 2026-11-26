import sys

if __package__:
    from .core import pending_python as _module
else:
    import core.pending_python as _module
sys.modules[__name__] = _module
