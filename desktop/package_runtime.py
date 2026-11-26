import importlib
import sys

sys.modules[__name__] = importlib.import_module("scripts.package_runtime")
