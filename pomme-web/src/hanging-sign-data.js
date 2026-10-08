// Factual model dimensions from Minecraft Java 1.20.4 and 1.21.11
// HangingSignRenderer.createHangingSignLayer: 64×32 sheet, native model pixels.
export const HANGING_SIGN_PARTS = Object.freeze({
  board: { uv: [0, 12], origin: [-7, 0, -1], size: [14, 10, 2], offset: [0, 0, 0], yaw: 0 },
  plank: { uv: [0, 0], origin: [-8, -6, -2], size: [16, 2, 4], offset: [0, 0, 0], yaw: 0 },
  chainL1: { uv: [0, 6], origin: [-1.5, 0, 0], size: [3, 6, 0], offset: [-5, -6, 0], yaw: -0.7853982 },
  chainL2: { uv: [6, 6], origin: [-1.5, 0, 0], size: [3, 6, 0], offset: [-5, -6, 0], yaw: 0.7853982 },
  chainR1: { uv: [0, 6], origin: [-1.5, 0, 0], size: [3, 6, 0], offset: [5, -6, 0], yaw: -0.7853982 },
  chainR2: { uv: [6, 6], origin: [-1.5, 0, 0], size: [3, 6, 0], offset: [5, -6, 0], yaw: 0.7853982 },
  vChains: { uv: [14, 6], origin: [-6, -6, 0], size: [12, 6, 0], offset: [0, 0, 0], yaw: 0 },
});
export const HANGING_SIGN_ATTACHMENTS = Object.freeze({
  wall: ['board', 'plank', 'chainL1', 'chainL2', 'chainR1', 'chainR2'],
  ceiling: ['board', 'chainL1', 'chainL2', 'chainR1', 'chainR2'],
  ceiling_middle: ['board', 'vChains'],
});
