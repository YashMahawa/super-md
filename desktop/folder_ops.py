import sys

if __package__:
    from .core import folder_ops as _module
else:
    import core.folder_ops as _module
sys.modules[__name__] = _module
