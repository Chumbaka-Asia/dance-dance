"""
Dance-Dance -- offline BVH -> baked 2D bone-angle-track baker.

Standalone (does NOT import animated_drawings.model.bvh, which transitively
pulls in OpenGL via model/box.py). Re-implements BVH hierarchy/motion parsing
and forward kinematics directly in numpy, following the same parsing rules
Meta's animated_drawings/model/bvh.py uses (same file format, same recursive
grammar) -- verified by reading that module -- but with zero GL dependency,
so this runs in a bare `numpy` + `pyyaml` virtualenv.

What this produces is a *simplification* of Meta's PCA "twisted-perspective"
retargeter: instead of per-limb PCA-plane projection, it uses a single
frontal (drop-Z) projection for every BVH joint, then reads off world-space
bone angles for the 10 char bones that the retarget config
(external/retarget/fair1_ppf.yaml) allows to rotate independently
(the rest -- shoulders, hips -- move rigidly with the torso/root). This is
the "baked angle tracks" approximation flagged as acceptable in the plan;
upgrading to a ported PCA retargeter is a later fidelity option.

Usage (requires numpy):
    python scripts/bake_dances.py

Output: dances.js (window.DanceData), sibling to this script.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

HERE = Path(__file__).parent
EXTERNAL = HERE.parent / 'external'
BVH_DIR = EXTERNAL / 'bvh'
RETARGET_DIR = EXTERNAL / 'retarget'

# char bone -> (bvh_joint_from, bvh_joint_to) that defines that bone's
# world-space direction. Different BVH sources use different skeleton naming
# conventions, so -- exactly as Meta's own per-source retarget configs do
# (external/retarget/fair1_ppf.yaml for rokoko/fair1 sources vs.
# external/retarget/cmu1_pfp.yaml for cmu1 sources) -- each mapping below is taken verbatim
# from the matching retarget config's char_joint_bvh_joints_mapping. Bones
# not listed (shoulders, hips) move rigidly with the torso/root and get no
# independent rotation track, matching those configs' char_bodypart_groups
# (listed only as *depth drivers*, never as their own bvh_depth_drivers
# entry with a rotating child bone).
BONE_MAPPING_FAIR1: Dict[str, Tuple[str, str]] = {
    'torso':        ('Hips', 'Spine3'),
    'neck':         ('Hips', 'Neck'),
    'left_elbow':   ('LeftArm', 'LeftForeArm'),
    'left_hand':    ('LeftForeArm', 'LeftHand'),
    'left_knee':    ('LeftUpLeg', 'LeftLeg'),
    'left_foot':    ('LeftLeg', 'LeftFoot'),
    'right_elbow':  ('RightArm', 'RightForeArm'),
    'right_hand':   ('RightForeArm', 'RightHand'),
    'right_knee':   ('RightUpLeg', 'RightLeg'),
    'right_foot':   ('RightLeg', 'RightFoot'),
}

# external/retarget/cmu1_pfp.yaml : char_joint_bvh_joints_mapping
BONE_MAPPING_CMU1: Dict[str, Tuple[str, str]] = {
    'torso':        ('Hips', 'Chest2'),
    'neck':         ('Hips', 'Head'),
    'left_elbow':   ('LeftShoulder', 'LeftElbow'),
    'left_hand':    ('LeftElbow', 'LeftWrist'),
    'left_knee':    ('LeftHip', 'LeftKnee'),
    'left_foot':    ('LeftKnee', 'LeftAnkle'),
    'right_elbow':  ('RightShoulder', 'RightElbow'),
    'right_hand':   ('RightElbow', 'RightWrist'),
    'right_knee':   ('RightHip', 'RightKnee'),
    'right_foot':   ('RightKnee', 'RightAnkle'),
}

# rokoko's own spine chain is Hips -> Spine -> Spine1 -> Spine2 -> {Neck,
# shoulders} -- one segment shorter than fair1's (which continues to
# Spine3 before Neck) -- so torso must resolve to Spine2, its actual last
# spine joint, instead of the nonexistent Spine3 (BONE_MAPPING_FAIR1's
# value). Arm/leg joint names are otherwise identical to fair1's.
BONE_MAPPING_ROKOKO: Dict[str, Tuple[str, str]] = {**BONE_MAPPING_FAIR1, 'torso': ('Hips', 'Spine2')}

# Bandai Namco Research Motiondataset uses a standard industrial skeleton
# with a single (unnumbered) Spine and Chest instead of Spine1/2/3 --
# Hips -> Spine -> Chest -> Neck; arms are UpperArm/LowerArm instead of
# LeftArm/LeftForeArm; legs are UpperLeg/LowerLeg instead of LeftUpLeg/LeftLeg.
BONE_MAPPING_BANDAI: Dict[str, Tuple[str, str]] = {
    'torso':        ('Hips', 'Chest'),
    'neck':         ('Hips', 'Neck'),
    'left_elbow':   ('UpperArm_L', 'LowerArm_L'),
    'left_hand':    ('LowerArm_L', 'Hand_L'),
    'left_knee':    ('UpperLeg_L', 'LowerLeg_L'),
    'left_foot':    ('LowerLeg_L', 'Foot_L'),
    'right_elbow':  ('UpperArm_R', 'LowerArm_R'),
    'right_hand':   ('LowerArm_R', 'Hand_R'),
    'right_knee':   ('UpperLeg_R', 'LowerLeg_R'),
    'right_foot':   ('LowerLeg_R', 'Foot_R'),
}

MAPPINGS = {'fair1': BONE_MAPPING_FAIR1, 'cmu1': BONE_MAPPING_CMU1, 'rokoko': BONE_MAPPING_ROKOKO, 'bandai': BONE_MAPPING_BANDAI}

# Which dances to bake: (name, bvh relative path, bone mapping to use --
# picked per source skeleton, see BONE_MAPPING_* above).
DANCES = [
    ('jesse_dance',   BVH_DIR / 'rokoko' / 'jesse_dance.bvh',    'rokoko'),
    ('jumping_jacks', BVH_DIR / 'cmu1' / 'jumping_jacks.bvh',    'cmu1'),
    ('dance_short',   BVH_DIR / 'bandai' / 'dataset-1_dance-short_normal_001.bvh', 'bandai'),
    ('bye_giant',     BVH_DIR / 'bandai' / 'dataset-1_bye_giant_001.bvh',          'bandai'),
    ('dash_proud',    BVH_DIR / 'bandai' / 'dataset-1_dash_proud_001.bvh',         'bandai'),
]

TARGET_FPS = 24  # resample every baked dance to this rate to bound dances.js size


# ---------------------------------------------------------------------------
# BVH parsing (mirrors animated_drawings/model/bvh.py's grammar, GL-free)
# ---------------------------------------------------------------------------

class BvhJoint:
    __slots__ = ('name', 'offset', 'channels', 'children', 'is_end_site')

    def __init__(self, name: str, offset: np.ndarray, channels: List[str], is_end_site: bool):
        self.name = name
        self.offset = offset
        self.channels = channels
        self.children: List['BvhJoint'] = []
        self.is_end_site = is_end_site


def _parse_skeleton(lines: List[str]) -> BvhJoint:
    line = lines.pop(0).strip()
    if line.startswith('ROOT') or line.startswith('JOINT'):
        _, name = line.split(' ', 1)
        is_end_site = False
    elif line.startswith('End Site'):
        name = line
        is_end_site = True
    else:
        raise ValueError(f'Malformed BVH line: {line}')

    assert lines.pop(0).strip() == '{'

    offset_line = lines.pop(0).strip()
    assert offset_line.startswith('OFFSET')
    _, *xyz = offset_line.split()
    offset = np.array(list(map(float, xyz)), dtype=np.float64)

    channels: List[str] = []
    if lines[0].strip().startswith('CHANNELS'):
        parts = lines.pop(0).strip().split()
        _, n, *channels = parts
        assert int(n) == len(channels)

    joint = BvhJoint(name, offset, channels, is_end_site)
    while lines[0].strip() != '}':
        joint.children.append(_parse_skeleton(lines))
    lines.pop(0)  # '}'
    return joint


def parse_bvh(path: Path):
    lines = path.read_text().splitlines()
    assert lines.pop(0).strip() == 'HIERARCHY'
    root = _parse_skeleton(lines)
    assert lines.pop(0).strip() == 'MOTION'
    frame_count = int(lines.pop(0).split(':')[-1])
    frame_time = float(lines.pop(0).split(':')[-1])
    frames = [list(map(float, ln.split())) for ln in lines if ln.strip()]
    assert len(frames) == frame_count, f'{path.name}: expected {frame_count} frames, found {len(frames)}'
    return root, frame_count, frame_time, np.array(frames, dtype=np.float64)


def _flatten_joints(joint: BvhJoint, out: List[BvhJoint]):
    if not joint.is_end_site:
        out.append(joint)
    for c in joint.children:
        _flatten_joints(c, out)


def _rotation_matrix(order: str, angles_deg: Tuple[float, float, float]) -> np.ndarray:
    """Intrinsic rotation about the axes named in `order` (e.g. 'yxz'),
    applied in that sequence -- the standard BVH convention (each CHANNELS
    line lists rotation channels in application order)."""
    mats = {'x': _rot_x, 'y': _rot_y, 'z': _rot_z}
    m = np.eye(3)
    for axis, deg in zip(order, angles_deg):
        m = m @ mats[axis](math.radians(deg))
    return m


def _rot_x(t):
    c, s = math.cos(t), math.sin(t)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def _rot_y(t):
    c, s = math.cos(t), math.sin(t)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def _rot_z(t):
    c, s = math.cos(t), math.sin(t)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def fk_world_positions(root: BvhJoint, frame_values: np.ndarray) -> Dict[str, np.ndarray]:
    """Returns {joint_name: world_xyz} for one frame, walking the hierarchy
    with a channel-value cursor (mirrors bvh.py's ptr-based recursion)."""
    positions: Dict[str, np.ndarray] = {}
    cursor = [0]

    def walk(joint: BvhJoint, parent_world: np.ndarray):
        local = np.eye(4)
        local[:3, 3] = joint.offset
        n = len(joint.channels)
        vals = frame_values[cursor[0]:cursor[0] + n]
        cursor[0] += n

        rot_axes = ''
        rot_vals: List[float] = []
        for ch, v in zip(joint.channels, vals):
            if ch == 'Xposition':
                local[0, 3] = joint.offset[0] + v
            elif ch == 'Yposition':
                local[1, 3] = joint.offset[1] + v
            elif ch == 'Zposition':
                local[2, 3] = joint.offset[2] + v
            elif ch.endswith('rotation'):
                rot_axes += ch[0].lower()
                rot_vals.append(v)
        if rot_axes:
            local[:3, :3] = _rotation_matrix(rot_axes, tuple(rot_vals))

        world = parent_world @ local
        if not joint.is_end_site:
            positions[joint.name] = world[:3, 3].copy()
        for c in joint.children:
            walk(c, world)

    walk(root, np.eye(4))
    return positions


# ---------------------------------------------------------------------------
# Baking: world positions per frame -> 10 char-bone world-space 2D angles
# + a normalized root/hip translation track
# ---------------------------------------------------------------------------

def project_2d(p3: np.ndarray, lateral_axis: int, up_axis: int, up_sign: float) -> Tuple[float, float]:
    """Frontal projection onto the detected (lateral, up) plane, dropping the
    third (depth) axis; flip the up component so world-up maps to image-up
    under our template's y-down image space. Lateral sign is kept positive
    (mirrored dancers read fine either way for a symmetric dance floor)."""
    return (float(p3[lateral_axis]), float(-p3[up_axis] * up_sign))


_AXIS_NAMES = ['X', 'Y', 'Z']


def detect_up_axis(root: BvhJoint, frames: np.ndarray, bone_mapping: Dict[str, Tuple[str, str]]) -> Tuple[int, int, float]:
    """Auto-detects which raw BVH axis is vertical for this source, so we
    don't have to hardcode a Y-up assumption that not every BVH source
    actually follows (e.g. some are Z-up) -- see the 'neck' bone's own
    (proximal, distal) pair, which bone_mapping already guarantees exists in
    this file. Averages over several sampled frames so a single unusual pose
    doesn't skew the result."""
    j_from, j_to = bone_mapping['neck']
    frame_count = frames.shape[0]
    idxs = range(0, frame_count, max(1, frame_count // 20))
    deltas = []
    for fi in idxs:
        joints = fk_world_positions(root, frames[fi])
        deltas.append(joints[j_to] - joints[j_from])
    up_vec = np.mean(deltas, axis=0)
    up_axis = int(np.argmax(np.abs(up_vec)))
    up_sign = 1.0 if up_vec[up_axis] >= 0 else -1.0
    lateral_axis = min(a for a in (0, 1, 2) if a != up_axis)
    return lateral_axis, up_axis, up_sign


def bake_dance(name: str, bvh_path: Path, bone_mapping: Dict[str, Tuple[str, str]]):
    root, frame_count, frame_time, frames = parse_bvh(bvh_path)
    src_fps = 1.0 / frame_time
    stride = max(1, round(src_fps / TARGET_FPS))
    frame_idxs = list(range(0, frame_count, stride))

    lateral_axis, up_axis, up_sign = detect_up_axis(root, frames, bone_mapping)
    print(f'    detected up-axis: {_AXIS_NAMES[up_axis]} ({"+" if up_sign > 0 else "-"}), '
          f'lateral axis: {_AXIS_NAMES[lateral_axis]}')

    tracks: Dict[str, List[float]] = {bone: [] for bone in bone_mapping}
    root_xs: List[float] = []
    root_ys: List[float] = []
    warned_missing: set = set()  # (bone, joint) pairs already reported, once per bake_dance call

    for fi in frame_idxs:
        joints = fk_world_positions(root, frames[fi])
        for bone, (j_from, j_to) in bone_mapping.items():
            if j_from not in joints or j_to not in joints:
                missing = j_from if j_from not in joints else j_to
                if (bone, missing) not in warned_missing:
                    warned_missing.add((bone, missing))
                    print(f'    WARNING {name}/{bone}: BVH joint "{missing}" not found -- '
                          f'falling back to angle 0.0 for every frame (wrong bone_mapping for this BVH source?)')
                tracks[bone].append(0.0)
                continue
            a = project_2d(joints[j_from], lateral_axis, up_axis, up_sign)
            b = project_2d(joints[j_to], lateral_axis, up_axis, up_sign)
            angle = math.atan2(b[1] - a[1], b[0] - a[0])
            tracks[bone].append(round(angle, 4))
        hip = joints.get('Hips')
        if hip is not None:
            hx, hy = project_2d(hip, lateral_axis, up_axis, up_sign)
            root_xs.append(hx)
            root_ys.append(hy)
        else:
            root_xs.append(0.0)
            root_ys.append(0.0)

    # Normalize root track to a small centered wobble (unit: fraction of BVH
    # hip-height scale) rather than raw BVH units, so the runtime can scale
    # it by the placed figure's own size. One shared span (the larger of the
    # x- and y-deviation) normalizes both axes together, preserving their
    # relative proportion -- using y's span alone for both (as before) badly
    # over-scaled x whenever a dance's lateral sway is larger than its
    # vertical bob (any of these dances could hit this; the up-axis fix
    # above made wave_hello's true, small vertical excursion visible for the
    # first time, exposing a >10x mismatch that was previously masked).
    if root_ys:
        cy = sum(root_ys) / len(root_ys)
        cx = sum(root_xs) / len(root_xs)
        span_y = max(abs(y - cy) for y in root_ys)
        span_x = max(abs(x - cx) for x in root_xs)
        span = max(1e-6, span_x, span_y)
        root_xs = [round((x - cx) / span, 4) for x in root_xs]
        root_ys = [round((y - cy) / span, 4) for y in root_ys]

    return {
        'fps': round(src_fps / stride, 3),
        'frameCount': len(frame_idxs),
        'tracks': tracks,
        'root': {'x': root_xs, 'y': root_ys},
    }


def main():
    dances = {}
    for name, bvh_path, mapping_key in DANCES:
        if not bvh_path.exists():
            print(f'  SKIP {name}: {bvh_path} not found')
            continue
        print(f'  baking {name} <- {bvh_path.relative_to(EXTERNAL)} ({mapping_key} mapping)')
        dances[name] = bake_dance(name, bvh_path, MAPPINGS[mapping_key])
        fc = dances[name]['frameCount']
        print(f'    {fc} frames @ {dances[name]["fps"]} fps')
        for bone, vals in dances[name]['tracks'].items():
            assert all(math.isfinite(v) for v in vals), f'{name}/{bone} has non-finite values'

    out_path = HERE / 'dances.js'
    payload = json.dumps({'dances': dances}, separators=(',', ':'))
    out_path.write_text('window.DanceData = ' + payload + ';\n', encoding='utf-8')
    print(f'\nWrote {out_path} ({out_path.stat().st_size:,} bytes), {len(dances)} dance(s).')


if __name__ == '__main__':
    main()
