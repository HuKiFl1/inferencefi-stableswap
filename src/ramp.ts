import type { Height, RampState } from "./types.js";

/**
 * Precise A at `height` (Curve 3pool `_A`, lines 149-166, in blocks instead of
 * seconds). Linear interpolation from initialA at initialHeight to futureA at
 * futureHeight. Integer division truncates the step, so the interpolated value
 * always lies between the endpoints and rounds toward initialA.
 */
export function ampAt(ramp: RampState, height: Height): bigint {
  const { initialA, futureA, initialHeight, futureHeight } = ramp;
  if (height >= futureHeight) return futureA;
  if (height <= initialHeight) return initialA;
  const elapsed = height - initialHeight;
  const duration = futureHeight - initialHeight;
  return futureA > initialA
    ? initialA + ((futureA - initialA) * elapsed) / duration
    : initialA - ((initialA - futureA) * elapsed) / duration;
}
