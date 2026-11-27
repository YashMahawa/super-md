import sys

if __package__:
    from .scripts import package_runtime as _module

    setattr(sys.modules[__package__], __name__.rsplit(".", 1)[-1], _module)
else:
    try:
        import scripts.package_runtime as _module
    except ModuleNotFoundError as _exc:
        if _exc.name not in ("scripts", "scripts.package_runtime"):
            raise
        from desktop.scripts import package_runtime as _module

sys.modules[__name__] = _module
