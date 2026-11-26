import sys

if __package__:
    from .core import updates as _module
else:
    import core.updates as _module
sys.modules[__name__] = _module
