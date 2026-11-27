import sys

if __package__:
    from .core import background_service as _module
else:
    import core.background_service as _module
sys.modules[__name__] = _module
