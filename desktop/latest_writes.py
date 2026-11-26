import sys

if __package__:
    from .core import latest_writes as _module
else:
    import core.latest_writes as _module
sys.modules[__name__] = _module
