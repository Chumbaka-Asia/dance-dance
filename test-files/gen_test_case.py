"""Generates a small test mesh + two pin configurations (rest, posed) and
dumps them to test_case.json, for cross-checking arap.js against the
reference arap.py (vendored under external/). Requires numpy and scipy."""
import json
import sys
from pathlib import Path

import numpy as np
if not hasattr(np, 'bool8'):
    np.bool8 = np.bool_  # numpy>=2.0 removed this alias; arap.py (unmodified, upstream) still uses it

HERE = Path(__file__).parent
EXTERNAL = HERE.parent / 'external'

# arap.py is unmodified upstream Meta code, written against numpy<2; patch
# the one numpy-2.x scalar-conversion incompatibility (int() on a >0-d
# array) in-memory via source text substitution, rather than editing the
# vendored file on disk, so this stays a read-only cross-check against
# their exact algorithm.
arap_src_path = EXTERNAL / 'animated_drawings' / 'model' / 'arap.py'
arap_src = arap_src_path.read_text()
arap_src = arap_src.replace(
    't_idx = int(containing_t_idxs[0])',
    't_idx = int(containing_t_idxs.flatten()[0])',
)
import types  # noqa: E402
arap_module = types.ModuleType('arap_patched')
arap_module.__file__ = str(arap_src_path)
exec(compile(arap_src, str(arap_src_path), 'exec'), arap_module.__dict__)
ARAP = arap_module.ARAP

# A simple humanoid-ish grid mesh: a 5x9 grid of vertices (like a torso+limb
# stand-in), triangulated regularly. Small enough to be a fast, deterministic
# cross-check of the ARAP math itself (mesh generation is tested separately).
cols, rows = 5, 9
vertices = []
for r in range(rows):
    for c in range(cols):
        vertices.append([c * 10.0, r * 10.0])
vertices = np.array(vertices, dtype=np.float32)

triangles = []
for r in range(rows - 1):
    for c in range(cols - 1):
        v0 = r * cols + c
        v1 = r * cols + (c + 1)
        v2 = (r + 1) * cols + c
        v3 = (r + 1) * cols + (c + 1)
        triangles.append([v0, v1, v2])
        triangles.append([v1, v3, v2])
triangles_np = [np.array(t, dtype=np.int32) for t in triangles]

# Pins: four corners + midpoints of top/bottom (mimics joint control points)
pins_rest = np.array([
    [0, 0], [40, 0], [0, 80], [40, 80], [20, 0], [20, 80],
], dtype=np.float32)

# Posed: bend the "top" pins sideways and down, like an arm/leg swinging --
# exercises real rotation, not just translation.
pins_posed = np.array([
    [5, 5], [30, 15], [-5, 75], [45, 85], [22, 8], [18, 78],
], dtype=np.float32)

arap = ARAP(pins_rest, triangles_np, vertices)
result = arap.solve(pins_posed)

out = {
    'vertices': vertices.tolist(),
    'triangles': [t.tolist() for t in triangles_np],
    'pinsRest': pins_rest.tolist(),
    'pinsPosed': pins_posed.tolist(),
    'expected': result.tolist(),
}
(HERE / 'test_case.json').write_text(json.dumps(out))
print(f'Wrote test_case.json: {len(vertices)} verts, {len(triangles)} tris, {len(pins_rest)} pins')
print('expected[0:3] =', result[:3].tolist())
