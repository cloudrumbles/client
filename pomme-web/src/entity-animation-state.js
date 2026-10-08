// Vanilla 1.20.4 Guardian.aiStep and Slime.tick run cosmetic client state at
// twenty ticks per second. Render frequency never changes their motion.
const mix = (a, b, t) => a + (b - a) * t;
const approachAngle = (a, b, maximum) => a + Math.max(-maximum, Math.min(maximum, ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI));
export function advanceEntityAnimation(track, time, { moving = false, inWater = true, sideHeads = [], bodyYaw = track.entity.yaw || 0 } = {}) {
  const family = track.definition.name;
  if (!['guardian', 'elder_guardian', 'slime', 'magma_cube', 'wither'].includes(family)) return null;
  const targetTick = Math.floor(time * 20), ground = Boolean(track.entity.onGround);
  let state = track.animationState;
  if (!state) state = track.animationState = { tick: targetTick, spikes: 0, oldSpikes: 0, tail: 0, oldTail: 0, tailSpeed: 0, squish: 0, oldSquish: 0, targetSquish: 0, ground, heads: [{ yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 }] };
  // A paused/background tab must not execute an unbounded backlog. These
  // damped cosmetic recurrences converge well before one hundred ticks.
  if (targetTick - state.tick > 100) state.tick = targetTick - 100;
  while (state.tick < targetTick) {
    state.tick++;
    if (family === 'guardian' || family === 'elder_guardian') {
      state.oldTail = state.tail; state.oldSpikes = state.spikes;
      state.tailSpeed = !inWater ? 2 : moving ? state.tailSpeed < .5 ? 4 : mix(state.tailSpeed, .5, .1) : mix(state.tailSpeed, .125, .2);
      state.tail += state.tailSpeed;
      // On land vanilla chooses a random spike position every tick. A local
      // deterministic random sample keeps previews and replays reproducible.
      state.spikes = !inWater ? Math.abs(Math.sin(state.tick * 12.9898 + (track.entity.id || 0) * 78.233) * 43758.5453) % 1 : mix(state.spikes, moving ? 0 : 1, moving ? .25 : .06);
    } else if (family === 'wither') {
      for (let head = 0; head < 2; head++) {
        const target = sideHeads[head], angles = state.heads[head];
        angles.yaw = approachAngle(angles.yaw, target?.yaw ?? bodyYaw, Math.PI / 18);
        if (target) angles.pitch = approachAngle(angles.pitch, target.pitch, Math.PI * 2 / 9);
      }
    } else {
      state.squish = mix(state.squish, state.targetSquish, .5); state.oldSquish = state.squish;
      if (ground !== state.ground) state.targetSquish = ground ? -.5 : 1;
      state.ground = ground; state.targetSquish *= family === 'magma_cube' ? .9 : .6;
    }
  }
  const partial = time * 20 - targetTick;
  return { spikes: mix(state.oldSpikes, state.spikes, partial), tail: mix(state.oldTail, state.tail, partial), squish: mix(state.oldSquish, state.squish, partial), sideHeads: state.heads.map(head => ({ yaw: head.yaw - bodyYaw, pitch: head.pitch })) };
}
