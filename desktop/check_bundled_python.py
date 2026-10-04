"""Release check: the packaged app's built-in Python runs a matplotlib 3D cell."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

CELL = """import numpy as np, statistics, fractions
import matplotlib.pyplot as plt
x, y = np.meshgrid(np.linspace(-2, 2, 16), np.linspace(-2, 2, 16))
ax = plt.figure().add_subplot(111, projection="3d")
ax.plot_surface(x, y, x*x + y*y)
print(statistics.mean([1, 2, 3]), fractions.Fraction(1, 3))
"""

def main(executable: str) -> int:
    with tempfile.TemporaryDirectory() as folder:
        source, result = Path(folder) / "cell.json", Path(folder) / "result.json"
        source.write_text(json.dumps({"code": CELL}), encoding="utf-8")
        process = subprocess.run([executable, "--python-cell", str(source), str(result)], capture_output=True, text=True, timeout=180)
        if not result.is_file():
            print(process.stdout, process.stderr, file=sys.stderr)
            return 1
        output = json.loads(result.read_text(encoding="utf-8"))
    if not output["ok"] or len(output["images"]) != 1 or "2.0 1/3" not in output["stdout"].replace("2 1/3", "2.0 1/3"):
        print(json.dumps(output)[:4000], file=sys.stderr)
        return 1
    print("Built-in Python ran numpy, matplotlib 3D and the standard library")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
