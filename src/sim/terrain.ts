import { fbm, smoothstep } from './noise';

// World axes: +X east, +Y up, -Z north. Units are meters.
export const TERRAIN_SIZE = 48000;
export const GRID = 320;
export const CELL = TERRAIN_SIZE / GRID;
export const BASE_ELEV = 300;

// Airbase layout (shared by physics and rendering).
export const RUNWAY = { x: 0, width: 45, zSouth: 1500, zNorth: -1500 };
export const AIRBASE_RECT = { minX: -800, maxX: 400, minZ: -1900, maxZ: 1900 };

export class Terrain {
  readonly heights: Float32Array;
  readonly seed: number;

  constructor(seed = 7) {
    this.seed = seed;
    this.heights = new Float32Array((GRID + 1) * (GRID + 1));
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const x = -TERRAIN_SIZE / 2 + i * CELL;
        const z = -TERRAIN_SIZE / 2 + j * CELL;
        this.heights[j * (GRID + 1) + i] = this.rawHeight(x, z);
      }
    }
  }

  private rawHeight(x: number, z: number): number {
    const s = this.seed;
    // Rolling dunes.
    let dev = (fbm(x / 2600, z / 2600, 4, s) - 0.5) * 90;
    // Rocky ridges, masked so mountains appear in bands rather than everywhere.
    const mask = smoothstep(0.42, 0.7, fbm(x / 11000 + 10, z / 11000 - 5, 3, s + 100));
    const r = 1 - Math.abs(fbm(x / 3800, z / 3800, 5, s + 200) * 2 - 1);
    dev += mask * r * r * r * 1300;
    // Flatten around the airbase.
    const dx = Math.max(AIRBASE_RECT.minX - x, 0, x - AIRBASE_RECT.maxX);
    const dz = Math.max(AIRBASE_RECT.minZ - z, 0, z - AIRBASE_RECT.maxZ);
    dev *= smoothstep(200, 3500, Math.hypot(dx, dz));
    // Keep the approach and departure corridors (runway 36/18, 14 km each way) low.
    const corr = Math.hypot(Math.max(Math.abs(x) - 500, 0), Math.max(Math.abs(z) - 14000, 0));
    dev *= 0.12 + 0.88 * smoothstep(300, 3500, corr);
    // Fade to flat at the map edge so it meets the surrounding ground plane.
    const edge = TERRAIN_SIZE / 2 - Math.max(Math.abs(x), Math.abs(z));
    dev *= smoothstep(0, 4000, edge);
    return BASE_ELEV + dev;
  }

  private h(i: number, j: number): number {
    return this.heights[j * (GRID + 1) + i];
  }

  /** Height of the rendered triangle mesh at (x, z). Matches the mesh exactly. */
  heightAt(x: number, z: number): number {
    const gx = (x + TERRAIN_SIZE / 2) / CELL;
    const gz = (z + TERRAIN_SIZE / 2) / CELL;
    if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return BASE_ELEV;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const h00 = this.h(i, j);
    const h10 = this.h(i + 1, j);
    const h01 = this.h(i, j + 1);
    const h11 = this.h(i + 1, j + 1);
    // Cells are split along the (0,0)-(1,1) diagonal, same as the mesh.
    if (fx >= fz) return h00 + (h10 - h00) * fx + (h11 - h10) * fz;
    return h00 + (h11 - h01) * fx + (h01 - h00) * fz;
  }
}
