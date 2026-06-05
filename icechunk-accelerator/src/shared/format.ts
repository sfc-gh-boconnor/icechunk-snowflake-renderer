import { VariableMeta } from '../types'

// ── Named colour palettes ─────────────────────────────────────────────────────
// Each is a list of RGB stops (low → high) that valueToRgba interpolates between.

export type PaletteKey =
  | 'auto'       // use the variable's own colorScale
  | 'viridis'
  | 'plasma'
  | 'inferno'
  | 'magma'
  | 'thermal'
  | 'blues'
  | 'reds'
  | 'greens'
  | 'spectral'

export interface Palette {
  label: string
  scale: [number, number, number][]
}

export const PALETTES: Record<Exclude<PaletteKey, 'auto'>, Palette> = {
  viridis:  { label: 'Viridis',  scale: [[68,1,84],[59,82,139],[33,145,140],[94,201,98],[253,231,37]] },
  plasma:   { label: 'Plasma',   scale: [[13,8,135],[126,3,168],[204,71,120],[248,149,64],[240,249,33]] },
  inferno:  { label: 'Inferno',  scale: [[0,0,4],[87,15,109],[188,55,84],[249,142,9],[252,255,164]] },
  magma:    { label: 'Magma',    scale: [[0,0,4],[79,18,123],[183,55,121],[252,137,97],[252,253,191]] },
  thermal:  { label: 'Thermal',  scale: [[5,48,97],[33,102,172],[103,169,207],[209,229,240],[253,219,199],[239,138,98],[178,24,43]] },
  blues:    { label: 'Blues',    scale: [[247,251,255],[198,219,239],[107,174,214],[33,113,181],[8,48,107]] },
  reds:     { label: 'Reds',     scale: [[255,245,240],[252,187,161],[252,109,76],[203,24,29],[103,0,13]] },
  greens:   { label: 'Greens',   scale: [[247,252,245],[199,233,192],[116,196,118],[35,139,69],[0,68,27]] },
  spectral: { label: 'Spectral', scale: [[94,79,162],[50,136,189],[171,221,164],[255,255,191],[253,174,97],[213,62,79],[158,1,66]] },
}

/**
 * Interpolate between two RGB colours.
 * t = 0 → lo, t = 1 → hi
 */
function lerp3(
  lo: [number, number, number],
  hi: [number, number, number],
  t: number
): [number, number, number] {
  return [
    Math.round(lo[0] + (hi[0] - lo[0]) * t),
    Math.round(lo[1] + (hi[1] - lo[1]) * t),
    Math.round(lo[2] + (hi[2] - lo[2]) * t),
  ]
}

/**
 * Map a transformed value to an RGBA colour using the variable's colorScale.
 * Returns [r, g, b, a] where a = 200 (semi-transparent).
 */
export function valueToRgba(
  value: number,
  min: number,
  max: number,
  colorScale: [number, number, number][]
): [number, number, number, number] {
  const range = max - min || 1
  const t = Math.max(0, Math.min(1, (value - min) / range))
  const idx = t * (colorScale.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.min(colorScale.length - 1, lo + 1)
  const f = idx - lo
  const [r, g, b] = lerp3(colorScale[lo], colorScale[hi], f)
  return [r, g, b, 200]
}

/**
 * Format a raw (already-transformed) value with units for display.
 */
export function formatValue(value: number, varKey: string): string {
  if (varKey === 'air_temperature') return `${value.toFixed(1)} °C`
  if (varKey === 'lwe_precipitation_rate') return `${value.toFixed(4)} mm/hr`
  if (varKey === 'air_pressure_at_sea_level') return `${value.toFixed(1)} hPa`
  if (varKey === 'relative_humidity') return `${value.toFixed(1)}%`
  if (varKey === 'wind_speed_at_10m') return `${value.toFixed(1)} m/s`
  if (varKey.startsWith('cloud_')) return `${value.toFixed(1)}%`
  return value.toFixed(2)
}

/**
 * Build a CSS linear-gradient string from a colorScale (low → high).
 */
export function buildGradient(colorScale: [number, number, number][]): string {
  const stops = colorScale
    .map((c, i) => {
      const pct = Math.round((i / (colorScale.length - 1)) * 100)
      return `rgb(${c[0]},${c[1]},${c[2]}) ${pct}%`
    })
    .join(', ')
  return `linear-gradient(to right, ${stops})`
}

/**
 * Format a Met Office run stamp for display.
 * "20260602T0000Z" → "2 Jun 2026 00:00Z"
 */
export function formatRunStamp(stamp: string): string {
  try {
    const year = parseInt(stamp.slice(0, 4))
    const month = parseInt(stamp.slice(4, 6)) - 1
    const day = parseInt(stamp.slice(6, 8))
    const hour = stamp.slice(9, 11)
    const min = stamp.slice(11, 13)
    const date = new Date(year, month, day)
    return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} ${hour}:${min}Z`
  } catch {
    return stamp
  }
}

/**
 * Given a bounding box and the current DeckGL viewState, compute
 * the approximate number of 0.09° grid cells that will be returned.
 */
export function estimateCellCount(
  latMin: number, latMax: number,
  lonMin: number, lonMax: number
): number {
  const latCells = Math.ceil((latMax - latMin) / 0.09375)
  const lonCells = Math.ceil((lonMax - lonMin) / 0.140625)
  return latCells * lonCells
}

/**
 * Returns a human-readable variable label with its unit.
 */
export function varLabel(meta: VariableMeta): string {
  return `${meta.label} (${meta.unit})`
}
