import sys

if __package__:
    from .core import instance as _module
else:
    import core.instance as _module
sys.modules[__name__] = _module
