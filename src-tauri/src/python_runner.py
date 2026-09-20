import contextlib
import io
import json
import os
import sys
import traceback

code = json.loads(sys.stdin.read())
stdout = io.StringIO()
stderr = io.StringIO()
images = []
ok = True

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception:
    plt = None

namespace = {"__name__": "__supermd__"}
try:
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        exec(compile(code, "<super-md-cell>", "exec"), namespace, namespace)
        if plt is not None:
            for number in plt.get_fignums():
                figure = plt.figure(number)
                target = os.path.abspath(f"figure-{number}.svg")
                figure.savefig(target, format="svg", bbox_inches="tight")
                with open(target, "rb") as handle:
                    import base64
                    images.append("data:image/svg+xml;base64," + base64.b64encode(handle.read()).decode("ascii"))
            plt.close("all")
except Exception:
    ok = False
    traceback.print_exc(file=stderr)

print(json.dumps({
    "stdout": stdout.getvalue(),
    "stderr": stderr.getvalue(),
    "images": images,
    "ok": ok,
}))
