import sys

if __package__:
    from .core import storage_inspector as _module
else:
    import core.storage_inspector as _module
sys.modules[__name__] = _module
