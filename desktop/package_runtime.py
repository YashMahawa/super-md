import sys

if __package__:
    from .scripts import package_runtime as _module
    setattr(sys.modules[__package__], __name__.rsplit(".", 1)[-1], _module)
else:
    import scripts.package_runtime as _module

sys.modules[__name__] = _module
