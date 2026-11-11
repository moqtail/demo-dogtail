# Copyright 2026 The MOQtail Authors
# SPDX-License-Identifier: Apache-2.0
"""
What a bot sees and does, shared by training and the TypeScript port (src/brain.ts must match
observe() exactly; test_brain.py checks it). Everything is relative to the bot's own nose.
"""
import numpy as np

from sim import (BULLET_SPEED, FIRE_COOLDOWN, ARMOR, RAPID, MAX_HP, RESPAWN_DELAY, SLOTS, SPEED, H, W,
                 wrap_delta)

K_ENEMIES, K_BULLETS, K_POWERS = 3, 6, 2
OBS = 7 + 8 * K_ENEMIES + 5 * K_BULLETS + 6 * K_POWERS
ACTIONS = 12  # turn (left, none, right) x boost (off, on) x fire (off, on)
DECIDE = 0.1  # s between decisions, as often as pos goes out
SUBSTEPS = 3  # physics frames per decision


def decode(act):
    """Action index to (turn, boost, fire)."""
    return (act % 3 - 1).astype(float), (act // 3) % 2 == 1, act // 6 == 1


def _rotate(dx, dy, a):
    """An offset into the frame of a plane heading a: +x ahead, +y to its right."""
    c, s = np.cos(a), np.sin(a)
    return dx * c + dy * s, -dx * s + dy * c


def _nearest(dist, k):
    """Indices of the k smallest along the last axis (inf = absent), and whether each is present."""
    idx = np.argsort(dist, axis=-1)[..., :k]
    return idx, np.isfinite(np.take_along_axis(dist, idx, -1))


def observe(ar, noise=0.0, rng=None):
    """(E, P, OBS) observations for every plane. noise: px of position error on other planes, as
    a bot sees them over the network (late, predicted)."""
    E, P = ar.E, ar.P
    a = ar.a
    alive = ar.alive
    feats = [
        ar.hp / (MAX_HP + 1),
        ar.shielded.astype(float),
        np.clip(ar.armor, 0, None) / ARMOR,
        np.clip(ar.rapid, 0, None) / RAPID,
        np.clip(ar.cooldown, 0, None) / FIRE_COOLDOWN,
        (~alive).astype(float),
        np.clip(ar.dead_for, 0, RESPAWN_DELAY) / RESPAWN_DELAY,
    ]
    out = [np.stack(feats, -1)]

    # Other planes, nearest first.
    ox, oy = ar.x, ar.y
    if noise and rng is not None:
        ox = ox + rng.normal(0, noise, ox.shape)
        oy = oy + rng.normal(0, noise, oy.shape)
    dx = wrap_delta(ar.x[:, :, None], ox[:, None, :], W)  # (E, me, other)
    dy = wrap_delta(ar.y[:, :, None], oy[:, None, :], H)
    dist = np.hypot(dx, dy)
    dist = np.where(np.eye(P, dtype=bool)[None] | ~alive[:, None, :], np.inf, dist)
    idx, present = _nearest(dist, K_ENEMIES)
    g = lambda arr: np.take_along_axis(arr, idx, -1)
    rx, ry = _rotate(g(dx), g(dy), a[:, :, None])
    rel = g(np.broadcast_to(ar.a[:, None, :], (E, P, P))) - a[:, :, None]
    other = lambda v: np.take_along_axis(np.broadcast_to(v[:, None, :], (E, P, P)), idx, -1)
    enemy = np.stack([present, rx / 800, ry / 800, g(dist) / 800, np.cos(rel), np.sin(rel),
                      other(ar.hp) / (MAX_HP + 1), other(ar.shielded.astype(float))], -1)
    out.append(np.where(present[..., None], enemy, 0).reshape(E, P, -1))

    # Others' bullets, nearest first.
    bx, by, ba = (v.reshape(E, 1, P * SLOTS) for v in (ar.bx, ar.by, ar.ba))
    on = ar.bon.reshape(E, 1, P * SLOTS) & (np.repeat(np.arange(P), SLOTS)[None, None] != np.arange(P)[None, :, None])
    dx = wrap_delta(ar.x[:, :, None], bx, W)
    dy = wrap_delta(ar.y[:, :, None], by, H)
    dist = np.where(on, np.hypot(dx, dy), np.inf)
    idx, present = _nearest(dist, K_BULLETS)
    g = lambda arr: np.take_along_axis(np.broadcast_to(arr, (E, P, P * SLOTS)), idx, -1)
    rx, ry = _rotate(g(dx), g(dy), a[:, :, None])
    rel = g(ba) - a[:, :, None]
    bullet = np.stack([present, rx / 400, ry / 400, np.cos(rel), np.sin(rel)], -1)
    out.append(np.where(present[..., None], bullet, 0).reshape(E, P, -1))

    # Power-ups, nearest first.
    n = ar.px.shape[1]
    dx = wrap_delta(ar.x[:, :, None], ar.px[:, None], W)
    dy = wrap_delta(ar.y[:, :, None], ar.py[:, None], H)
    dist = np.where(ar.pttl[:, None] > 0, np.hypot(dx, dy), np.inf)
    idx, present = _nearest(dist, K_POWERS)
    g = lambda arr: np.take_along_axis(np.broadcast_to(arr, (E, P, n)), idx, -1)
    rx, ry = _rotate(g(dx), g(dy), a[:, :, None])
    kind = g(ar.pkind[:, None])
    power = np.stack([present, rx / 800, ry / 800, kind == 0, kind == 1, kind == 2], -1).astype(float)
    out.append(np.where(present[..., None], power, 0).reshape(E, P, -1))
    return np.concatenate(out, -1).astype(np.float32)


def scripted(ar, rng, skill=1.0):
    """
    A rule-based pilot for every plane: chase the nearest plane, aim where it will be, fire when lined
    up. skill 0..1 sets aim noise and reaction. Returns action indices (E, P).
    """
    E, P = ar.E, ar.P
    dx = wrap_delta(ar.x[:, :, None], ar.x[:, None, :], W)
    dy = wrap_delta(ar.y[:, :, None], ar.y[:, None, :], H)
    dist = np.where(np.eye(P, dtype=bool)[None] | ~ar.alive[:, None, :], np.inf, np.hypot(dx, dy))
    t = np.argmin(dist, -1)
    g = lambda v: np.take_along_axis(v, t[..., None], -1)[..., 0]
    d = g(dist)
    lead = np.where(np.isfinite(d), d, 0) / BULLET_SPEED
    tx = g(dx) + np.cos(g(np.broadcast_to(ar.a[:, None], (E, P, P)))) * SPEED * lead
    ty = g(dy) + np.sin(g(np.broadcast_to(ar.a[:, None], (E, P, P)))) * SPEED * lead
    want = np.arctan2(ty, tx) + rng.normal(0, 0.25 * (1 - skill) + 0.02, (E, P))
    diff = np.arctan2(np.sin(want - ar.a), np.cos(want - ar.a))
    turn = np.where(np.abs(diff) < 0.05, 0, np.sign(diff))
    fire = (np.abs(diff) < 0.15) & (d < 550)
    boost = d > 450
    wander = ~np.isfinite(d) | (rng.random((E, P)) > 0.6 + 0.4 * skill)  # hesitates now and then
    turn = np.where(wander, rng.integers(-1, 2, (E, P)), turn)
    return ((turn + 1) + 3 * boost + 6 * fire).astype(np.int64)
