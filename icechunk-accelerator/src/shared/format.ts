import { VariableMeta } from '../types'

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
