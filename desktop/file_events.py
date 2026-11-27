import sys

if __package__:
    from .core import file_events as _module
else:
    import core.file_events as _module
sys.modules[__name__] = _module
