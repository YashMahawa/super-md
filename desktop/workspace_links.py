import sys

if __package__:
    from .core import workspace_links as _module
else:
    import core.workspace_links as _module
sys.modules[__name__] = _module
