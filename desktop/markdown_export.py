import sys

if __package__:
    from .core import markdown_export as _module
else:
    import core.markdown_export as _module
sys.modules[__name__] = _module
