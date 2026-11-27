import sys

if __package__:
    from .core import export_jobs as _module
else:
    import core.export_jobs as _module
sys.modules[__name__] = _module
