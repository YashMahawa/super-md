import sys

if __package__:
    from .core import network_tls as _module
else:
    import core.network_tls as _module
sys.modules[__name__] = _module
