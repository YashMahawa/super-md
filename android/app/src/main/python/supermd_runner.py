"""Explicit, offline Matplotlib execution. Imported lazily by the native bridge."""
import base64
import contextlib
import io
import json
import os
import traceback

def run(code, cache):
    os.environ["MPLCONFIGDIR"] = cache
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    stdout, stderr = io.StringIO(), io.StringIO()
    images, ok = [], True
    namespace = {"__name__": "__supermd__"}
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            plt.close("all")
            exec(compile(code, "<super-md-cell>", "exec"), namespace, namespace)
            for number in plt.get_fignums():
                output = io.BytesIO()
                plt.figure(number).savefig(output, format="svg", bbox_inches="tight")
                images.append("data:image/svg+xml;base64," + base64.b64encode(output.getvalue()).decode("ascii"))
    except Exception:
        ok = False
        traceback.print_exc(file=stderr)
    finally:
        plt.close("all")
    return json.dumps(dict(stdout=stdout.getvalue(), stderr=stderr.getvalue(), images=images, ok=ok))
