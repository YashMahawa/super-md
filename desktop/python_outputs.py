import sys

if __package__:
    from .core import python_outputs as _module
else:
    import core.python_outputs as _module
sys.modules[__name__] = _module
