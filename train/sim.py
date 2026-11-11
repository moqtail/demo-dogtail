# Copyright 2026 The MOQtail Authors
# SPDX-License-Identifier: Apache-2.0
"""
DOGtail's rules (src/game.ts) for training: many matches stepped at once in numpy arrays, no drawing,
no network. Arrays are (E, P): E matches of P planes. test_parity.py checks it against game.ts.
"""
import numpy as np

W, H = 2400.0, 1500.0
SPEED, BOOST, TURN = 180.0, 320.0, 3.0
BULLET_SPEED, BULLET_LIFE, FIRE_COOLDOWN, HIT_RADIUS = 520.0, 1.2, 0.2, 14.0
MAX_HP, SPAWN_SHIELD, RESPAWN_DELAY = 3, 1.5, 2.0
ARMOR, RAPID = 5.0, 6.0  # power-up durations, s (main.ts)
POWER_SLOT, POWER_LIFE, POWER_PER_SLOT, PICKUP_RADIUS = 8.0, 16.0, 4, 24.0
SHIELD_UP, RAPID_UP, HEART_UP = 0, 1, 2
SLOTS = 13  # bullets alive per plane at most: BULLET_LIFE / (FIRE_COOLDOWN / 2) + 1


def wrap(v, m):
    return np.mod(v, m)


def wrap_delta(a, b, m):
    """Signed shortest offset from a to b on a wrapping axis of length m (game.ts wrapDelta)."""
    return wrap(b - a + m / 2, m) - m / 2


class Arena:
    def __init__(self, E, P, seed=0, powerups=True, respawn=True):
        self.E, self.P = E, P
        self.rng = np.random.default_rng(seed)
        self.powerups, self.respawn = powerups, respawn
        z = lambda: np.zeros((E, P))
        self.x, self.y, self.a = z(), z(), z()
        self.hp = np.full((E, P), MAX_HP)
        self.dead_for, self.shield, self.armor, self.rapid, self.cooldown = z(), z(), z(), z(), z()
        self.shielded = np.zeros((E, P), bool)
        # Bullets: SLOTS per plane, so the owner is the plane index. seq orders them like game.ts's array.
        b = lambda: np.zeros((E, P, SLOTS))
        self.bx, self.by, self.ba, self.bage = b(), b(), b(), b()
        self.bon = np.zeros((E, P, SLOTS), bool)
        self.bseq = np.zeros((E, P, SLOTS), np.int64)
        self.seq = 0
        # Power-ups: a few slots per match; ttl > 0 while on the map.
        n = POWER_PER_SLOT * int(np.ceil(POWER_LIFE / POWER_SLOT))
        self.px, self.py = np.zeros((E, n)), np.zeros((E, n))
        self.pkind = np.zeros((E, n), np.int64)
        self.pttl = np.zeros((E, n))
        self.power_clock = self.rng.uniform(0, POWER_SLOT, E)
        self.t = 0.0
        self.spawn(np.ones((E, P), bool))

    def spawn(self, mask):
        k = int(mask.sum())
        self.x[mask] = self.rng.uniform(0, W, k)
        self.y[mask] = self.rng.uniform(0, H, k)
        self.a[mask] = self.rng.uniform(0, 2 * np.pi, k)
        self.hp[mask] = MAX_HP
        self.dead_for[mask] = 0
        self.shield[mask] = SPAWN_SHIELD
        self.armor[mask] = 0
        self.rapid[mask] = 0

    @property
    def alive(self):
        return self.dead_for <= 0

    def substep(self, turn, boost, fire, dt):
        """
        One frame, in main.ts's order. turn in {-1, 0, 1}, boost and fire bools, all (E, P).
        Returns per plane: hits dealt, hits taken, kills, deaths, power-ups grabbed (E, P).
        """
        E, P = self.E, self.P
        out = {k: np.zeros((E, P)) for k in ('dealt', 'taken', 'kills', 'deaths', 'grabs')}

        # Respawn after RESPAWN_DELAY.
        was_dead = self.dead_for > 0
        self.dead_for = np.where(was_dead, self.dead_for - dt, 0)
        back = was_dead & (self.dead_for <= 0)
        if self.respawn and back.any():
            self.spawn(back)
        elif not self.respawn:
            self.dead_for[was_dead] = np.inf  # parity runs: the dead stay out
        alive = self.alive

        self.shield -= dt
        self.armor -= dt
        self.rapid -= dt
        self.shielded = (self.shield > 0) | (self.armor > 0)

        if self.powerups:
            self._powerups(alive, out, dt)

        # stepPlane: turn, then move.
        self.a = np.where(alive, self.a + turn * TURN * dt, self.a)
        v = np.where(boost, BOOST, SPEED)
        self.x = np.where(alive, wrap(self.x + np.cos(self.a) * v * dt, W), self.x)
        self.y = np.where(alive, wrap(self.y + np.sin(self.a) * v * dt, H), self.y)

        # Fire: a bullet at the plane, in its oldest free slot. Firing gives up the spawn shield.
        self.cooldown -= dt
        shoot = alive & fire & (self.cooldown <= 0)
        if shoot.any():
            self.cooldown = np.where(shoot, np.where(self.rapid > 0, FIRE_COOLDOWN / 2, FIRE_COOLDOWN), self.cooldown)
            self.shield = np.where(shoot, 0, self.shield)
            slot = np.argmin(np.where(self.bon, self.bseq, -1), axis=2)  # a free slot sorts first
            e, p = np.nonzero(shoot)
            s = slot[e, p]
            self.bx[e, p, s], self.by[e, p, s], self.ba[e, p, s] = self.x[e, p], self.y[e, p], self.a[e, p]
            self.bage[e, p, s] = 0
            self.bon[e, p, s] = True
            # Same order as game.ts's bullets array: by frame, then by plane.
            self.bseq[e, p, s] = self.seq + np.arange(len(e))
            self.seq += len(e)

        # stepBullets
        self.bx = np.where(self.bon, wrap(self.bx + np.cos(self.ba) * BULLET_SPEED * dt, W), self.bx)
        self.by = np.where(self.bon, wrap(self.by + np.sin(self.ba) * BULLET_SPEED * dt, H), self.by)
        self.bage += dt
        self.bon &= self.bage < BULLET_LIFE

        # findHit, for every plane: the first (lowest seq) bullet of another plane within HIT_RADIUS.
        dx = np.abs(self.x[:, :, None, None] - self.bx[:, None])  # (E, target, owner, slot)
        dy = np.abs(self.y[:, :, None, None] - self.by[:, None])
        d = np.hypot(np.minimum(dx, W - dx), np.minimum(dy, H - dy))
        own = np.eye(P, dtype=bool)[None, :, :, None]
        can = alive & ~self.shielded
        hit = (d < HIT_RADIUS) & self.bon[:, None] & ~own & can[:, :, None, None]
        if hit.any():
            first = np.where(hit, self.bseq[:, None], np.iinfo(np.int64).max).reshape(E, P, -1).argmin(2)
            e, t = np.nonzero(hit.any((2, 3)))
            owner, s = np.divmod(first[e, t], SLOTS)
            # One plane can't use one bullet twice: the lower target index takes it, as in a shared array.
            taken = np.zeros_like(self.bon)
            for i in range(len(e)):
                if taken[e[i], owner[i], s[i]]:
                    # Gone to a plane checked earlier: this one takes its next bullet, if any.
                    left = hit[e[i], t[i]] & ~taken[e[i]]
                    if not left.any():
                        continue
                    nxt = np.where(left, self.bseq[e[i]], np.iinfo(np.int64).max).argmin()
                    owner[i], s[i] = divmod(nxt, SLOTS)
                taken[e[i], owner[i], s[i]] = True
                self.hp[e[i], t[i]] -= 1
                out['taken'][e[i], t[i]] += 1
                out['dealt'][e[i], owner[i]] += 1
                if self.hp[e[i], t[i]] <= 0:
                    self.dead_for[e[i], t[i]] = RESPAWN_DELAY
                    out['deaths'][e[i], t[i]] += 1
                    out['kills'][e[i], owner[i]] += 1
            self.bon &= ~taken
        self.t += dt
        return out

    def _powerups(self, alive, out, dt):
        self.pttl -= dt
        self.power_clock -= dt
        due = self.power_clock <= 0
        if due.any():
            self.power_clock[due] += POWER_SLOT
            for e in np.nonzero(due)[0]:
                for s in np.argsort(self.pttl[e])[:POWER_PER_SLOT]:
                    self.px[e, s], self.py[e, s] = self.rng.uniform(0, W), self.rng.uniform(0, H)
                    self.pkind[e, s] = self.rng.integers(3)
                    self.pttl[e, s] = POWER_LIFE
        dx = np.abs(self.x[:, :, None] - self.px[:, None])
        dy = np.abs(self.y[:, :, None] - self.py[:, None])
        near = (np.hypot(np.minimum(dx, W - dx), np.minimum(dy, H - dy)) < PICKUP_RADIUS)
        near &= alive[:, :, None] & (self.pttl[:, None] > 0)
        if not near.any():
            return
        for e, s in zip(*np.nonzero(near.any(1))):
            p = np.argmax(near[e, :, s])  # the lowest index touching it gets it
            k = self.pkind[e, s]
            if k == SHIELD_UP:
                self.armor[e, p] = ARMOR
            elif k == RAPID_UP:
                self.rapid[e, p] = RAPID
            else:
                self.hp[e, p] = min(self.hp[e, p] + 1, MAX_HP + 1)
            self.pttl[e, s] = 0
            out['grabs'][e, p] += 1
