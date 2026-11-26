import sys

if __package__:
    from .core import app_integration as _module
else:
    import core.app_integration as _module
sys.modules[__name__] = _module
