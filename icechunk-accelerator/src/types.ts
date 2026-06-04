// ── Core data shapes ─────────────────────────────────────────────────────────

export interface WeatherPoint {
  lat: number
  lon: number
  value: number
  h3index?: string
  cloud_pct?: number
  height_m?: number
}

export interface MetaResult {
  latest_snapshot: string
  branches: string[]
  tags: string[]
  variables: string[]
  snapshots?: Array<{ tag: string; label: string; snapshotId: string }>
  grid: {
    lat_count: number
    lon_count: number
    lat_range: number[]
    lon_range: number[]
  }
}

export interface BBox {
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
}

// ── Variable configuration ────────────────────────────────────────────────────

export interface VariableMeta {
  key: string
  label: string
  unit: string
  is3D: boolean
  transform: (v: number) => number
  colorScale: [number, number, number][]
  minHint: number
  maxHint: number
}

export const VARIABLES: VariableMeta[] = [
  {
    key: 'air_temperature',
    label: 'Temperature',
    unit: '°C',
    is3D: false,
    transform: v => v - 273.15,
    colorScale: [
      [5, 48, 97],
      [33, 102, 172],
      [103, 169, 207],
      [209, 229, 240],
      [253, 219, 199],
      [239, 138, 98],
      [178, 24, 43],
    ],
    minHint: -20,
    maxHint: 40,
  },
  {
    key: 'lwe_precipitation_rate',
    label: 'Precipitation',
    unit: 'mm/hr',
    is3D: false,
    transform: v => v * 3_600_000,
    colorScale: [
      [247, 252, 240],
      [224, 243, 219],
      [186, 228, 188],
      [128, 205, 193],
      [53, 151, 143],
      [1, 102, 94],
      [0, 60, 48],
    ],
    minHint: 0,
    maxHint: 5,
  },
  {
    key: 'air_pressure_at_sea_level',
    label: 'Pressure',
    unit: 'hPa',
    is3D: false,
    transform: v => v / 100,
    colorScale: [
      [240, 240, 255],
      [188, 189, 220],
      [136, 86, 167],
      [84, 39, 143],
      [63, 0, 125],
    ],
    minHint: 960,
    maxHint: 1040,
  },
  {
    key: 'relative_humidity',
    label: 'Humidity',
    unit: '%',
    is3D: false,
    transform: v => v * 100,
    colorScale: [
      [255, 255, 204],
      [199, 233, 180],
      [127, 205, 187],
      [65, 182, 196],
      [29, 145, 192],
      [34, 94, 168],
      [12, 44, 132],
    ],
    minHint: 0,
    maxHint: 100,
  },
  {
    key: 'wind_speed_at_10m',
    label: 'Wind Speed (10m)',
    unit: 'm/s',
    is3D: false,
    transform: v => v,
    colorScale: [
      [240, 248, 255],
      [150, 220, 150],
      [255, 220, 50],
      [255, 140, 0],
      [200, 0, 0],
      [100, 0, 150],
    ],
    minHint: 0,
    maxHint: 30,
  },
  {
    key: 'cloud_amount_of_total_cloud',
    label: 'Total Cloud',
    unit: '%',
    is3D: false,
    transform: v => v * 100,
    colorScale: [
      [13, 17, 23],
      [36, 62, 100],
      [100, 140, 180],
      [180, 205, 225],
      [240, 248, 255],
    ],
    minHint: 0,
    maxHint: 100,
  },
  {
    key: 'visibility_at_screen_level',
    label: 'Visibility',
    unit: 'km',
    is3D: false,
    transform: v => v / 1000,
    colorScale: [
      [10, 20, 80],
      [30, 80, 160],
      [80, 150, 200],
      [160, 210, 230],
      [220, 240, 250],
      [240, 248, 255],
    ],
    minHint: 0,
    maxHint: 30,
  },
  {
    key: 'cloud_amount_of_high_cloud',
    label: 'High Cloud',
    unit: '%',
    is3D: false,
    transform: v => v * 100,
    colorScale: [
      [13, 17, 23],
      [50, 90, 140],
      [140, 180, 220],
      [220, 235, 250],
    ],
    minHint: 0,
    maxHint: 100,
  },
  {
    key: 'cloud_amount_of_low_cloud',
    label: 'Low Cloud',
    unit: '%',
    is3D: false,
    transform: v => v * 100,
    colorScale: [
      [13, 17, 23],
      [50, 110, 80],
      [120, 180, 140],
      [200, 230, 210],
    ],
    minHint: 0,
    maxHint: 100,
  },
  {
    key: 'cloud_amount_of_medium_cloud',
    label: 'Medium Cloud',
    unit: '%',
    is3D: false,
    transform: v => v * 100,
    colorScale: [
      [13, 17, 23],
      [80, 80, 140],
      [150, 150, 200],
      [220, 220, 240],
    ],
    minHint: 0,
    maxHint: 100,
  },
  {
    key: 'cloud_amount_on_height_levels',
    label: 'Cloud by Height',
    unit: '%',
    is3D: true,
    transform: v => v * 100,
    colorScale: [
      [13, 17, 23],
      [36, 62, 100],
      [100, 140, 180],
      [180, 205, 225],
      [240, 248, 255],
    ],
    minHint: 0,
    maxHint: 100,
  },
]

export const VARIABLE_MAP: Record<string, VariableMeta> = Object.fromEntries(
  VARIABLES.map(v => [v.key, v])
)

/**
 * Build a VariableMeta for an unknown variable name by pattern-matching
 * against known aliases (e.g. "temperature" → air_temperature config).
 * Falls back to a generic identity-transform config.
 */
export function resolveVariableMeta(key: string): VariableMeta {
  // Direct match
  if (VARIABLE_MAP[key]) return VARIABLE_MAP[key]

  const k = key.toLowerCase()

  // Fuzzy matches
  if (k.includes('temperature') || k === 'temp') {
    return { ...VARIABLE_MAP['air_temperature'], key, label: key.replace(/_/g, ' ') }
  }
  if (k.includes('pressure') || k === 'pres' || k === 'pressure') {
    return { ...VARIABLE_MAP['air_pressure_at_sea_level'], key, label: key.replace(/_/g, ' ') }
  }
  if (k.includes('humidity') || k === 'humid') {
    return { ...VARIABLE_MAP['relative_humidity'], key, label: key.replace(/_/g, ' ') }
  }
  if (k.includes('precip') || k.includes('rain') || k.includes('lwe')) {
    return { ...VARIABLE_MAP['lwe_precipitation_rate'], key, label: key.replace(/_/g, ' ') }
  }
  if (k.includes('cloud')) {
    return { ...VARIABLE_MAP['cloud_amount_of_total_cloud'], key, label: key.replace(/_/g, ' ') }
  }
  if (k.includes('wind') || k.includes('speed')) {
    return { ...VARIABLE_MAP['wind_speed_at_10m'], key, label: key.replace(/_/g, ' ') }
  }
  if (k.includes('visibility') || k === 'vis') {
    return { ...VARIABLE_MAP['visibility_at_screen_level'], key, label: key.replace(/_/g, ' ') }
  }

  // Generic fallback — auto-range from actual data
  return {
    key, label: key.replace(/_/g, ' '), unit: '', is3D: false,
    transform: v => v,
    colorScale: [[240,240,255],[100,160,220],[50,80,180],[10,20,100]],
    minHint: 0, maxHint: 1,
  }
}

// ── Met Office ingestion config ───────────────────────────────────────────────

export interface IngestFile {
  filename: string
  label: string
  sizeMb: number
  varKey: string
}

export const INGEST_FILES: IngestFile[] = [
  { filename: 'temperature_at_screen_level.nc',      label: 'Temperature (screen level)', sizeMb: 7.3,  varKey: 'air_temperature' },
  { filename: 'precipitation_rate.nc',               label: 'Precipitation rate',         sizeMb: 2.2,  varKey: 'lwe_precipitation_rate' },
  { filename: 'pressure_at_mean_sea_level.nc',       label: 'Pressure (mean sea level)',  sizeMb: 8.0,  varKey: 'air_pressure_at_sea_level' },
  { filename: 'relative_humidity_at_screen_level.nc',label: 'Relative humidity',          sizeMb: 7.5,  varKey: 'relative_humidity' },
  { filename: 'wind_speed_at_10m.nc',               label: 'Wind speed (10m)',            sizeMb: 7.5,  varKey: 'wind_speed_at_10m' },
  { filename: 'cloud_amount_of_total_cloud.nc',      label: 'Total cloud cover',          sizeMb: 3.4,  varKey: 'cloud_amount_of_total_cloud' },
  { filename: 'cloud_amount_of_high_cloud.nc',       label: 'High cloud',                 sizeMb: 2.5,  varKey: 'cloud_amount_of_high_cloud' },
  { filename: 'cloud_amount_of_low_cloud.nc',        label: 'Low cloud',                  sizeMb: 3.7,  varKey: 'cloud_amount_of_low_cloud' },
  { filename: 'cloud_amount_of_medium_cloud.nc',     label: 'Medium cloud',               sizeMb: 2.4,  varKey: 'cloud_amount_of_medium_cloud' },
  { filename: 'cloud_amount_on_height_levels.nc',    label: 'Cloud by height (3D)',       sizeMb: 67.9, varKey: 'cloud_amount_on_height_levels' },
]

// ── Bounding box presets ──────────────────────────────────────────────────────

export interface BBoxPreset {
  label: string
  group: string
  bbox: BBox
}

export const BBOX_PRESETS: BBoxPreset[] = [
  // ── Global / overview ────────────────────────────────────────────
  { group: 'Overview',      label: 'Global',            bbox: { latMin: -90,  latMax: 90,   lonMin: -180, lonMax: 180  } },

  // ── Europe ───────────────────────────────────────────────────────
  { group: 'Europe',        label: 'Europe',            bbox: { latMin: 35,   latMax: 72,   lonMin: -25,  lonMax: 40   } },
  { group: 'Europe',        label: 'UK & Ireland',      bbox: { latMin: 49,   latMax: 61,   lonMin: -11,  lonMax: 2    } },
  { group: 'Europe',        label: 'France',            bbox: { latMin: 41,   latMax: 51,   lonMin: -5,   lonMax: 10   } },
  { group: 'Europe',        label: 'Germany',           bbox: { latMin: 47,   latMax: 55,   lonMin: 6,    lonMax: 15   } },
  { group: 'Europe',        label: 'Iberian Peninsula', bbox: { latMin: 36,   latMax: 44,   lonMin: -10,  lonMax: 5    } },
  { group: 'Europe',        label: 'Scandinavia',       bbox: { latMin: 54,   latMax: 72,   lonMin: 4,    lonMax: 32   } },
  { group: 'Europe',        label: 'Italy & Balkans',   bbox: { latMin: 36,   latMax: 47,   lonMin: 10,   lonMax: 30   } },

  // ── Americas ─────────────────────────────────────────────────────
  { group: 'Americas',      label: 'Continental USA',   bbox: { latMin: 24,   latMax: 50,   lonMin: -125, lonMax: -65  } },
  { group: 'Americas',      label: 'East Coast USA',    bbox: { latMin: 25,   latMax: 47,   lonMin: -82,  lonMax: -65  } },
  { group: 'Americas',      label: 'West Coast USA',    bbox: { latMin: 32,   latMax: 50,   lonMin: -125, lonMax: -114 } },
  { group: 'Americas',      label: 'Canada',            bbox: { latMin: 42,   latMax: 70,   lonMin: -141, lonMax: -52  } },
  { group: 'Americas',      label: 'Brazil',            bbox: { latMin: -34,  latMax: 5,    lonMin: -74,  lonMax: -34  } },
  { group: 'Americas',      label: 'Patagonia',         bbox: { latMin: -56,  latMax: -38,  lonMin: -76,  lonMax: -60  } },

  // ── Asia ─────────────────────────────────────────────────────────
  { group: 'Asia',          label: 'China',             bbox: { latMin: 18,   latMax: 54,   lonMin: 73,   lonMax: 135  } },
  { group: 'Asia',          label: 'Japan',             bbox: { latMin: 30,   latMax: 46,   lonMin: 129,  lonMax: 146  } },
  { group: 'Asia',          label: 'India',             bbox: { latMin: 8,    latMax: 36,   lonMin: 68,   lonMax: 97   } },
  { group: 'Asia',          label: 'SE Asia',           bbox: { latMin: -10,  latMax: 26,   lonMin: 95,   lonMax: 140  } },
  { group: 'Asia',          label: 'Middle East',       bbox: { latMin: 12,   latMax: 42,   lonMin: 32,   lonMax: 62   } },
  { group: 'Asia',          label: 'Korean Peninsula',  bbox: { latMin: 33,   latMax: 43,   lonMin: 124,  lonMax: 132  } },

  // ── Africa ───────────────────────────────────────────────────────
  { group: 'Africa',        label: 'Africa',            bbox: { latMin: -35,  latMax: 38,   lonMin: -18,  lonMax: 52   } },
  { group: 'Africa',        label: 'North Africa',      bbox: { latMin: 15,   latMax: 38,   lonMin: -18,  lonMax: 40   } },
  { group: 'Africa',        label: 'South Africa',      bbox: { latMin: -35,  latMax: -22,  lonMin: 16,   lonMax: 33   } },
  { group: 'Africa',        label: 'East Africa',       bbox: { latMin: -12,  latMax: 15,   lonMin: 29,   lonMax: 52   } },

  // ── Oceania ──────────────────────────────────────────────────────
  { group: 'Oceania',       label: 'Australia',         bbox: { latMin: -44,  latMax: -10,  lonMin: 113,  lonMax: 154  } },
  { group: 'Oceania',       label: 'New Zealand',       bbox: { latMin: -47,  latMax: -34,  lonMin: 166,  lonMax: 178  } },

  // ── Polar ────────────────────────────────────────────────────────
  { group: 'Polar',         label: 'Arctic',            bbox: { latMin: 65,   latMax: 90,   lonMin: -180, lonMax: 180  } },
  { group: 'Polar',         label: 'Antarctica',        bbox: { latMin: -90,  latMax: -60,  lonMin: -180, lonMax: 180  } },
]

// Convenience aliases kept for backwards compatibility
export const UK_BBOX:     BBox = BBOX_PRESETS.find(p => p.label === 'UK & Ireland')!.bbox
export const EUROPE_BBOX: BBox = BBOX_PRESETS.find(p => p.label === 'Europe')!.bbox
export const GLOBAL_BBOX: BBox = BBOX_PRESETS.find(p => p.label === 'Global')!.bbox

// ── Dataset configuration ─────────────────────────────────────────────────────

export type Dataset = 'global' | 'uk'

export interface DatasetConfig {
  id: Dataset
  label: string
  description: string
  sliceH3Function: string
  defaultBbox: BBox
}

export const DATASETS: DatasetConfig[] = [
  {
    id: 'global',
    label: '🌍 Global 10km',
    description: 'Met Office Global Deterministic 10km — worldwide coverage',
    sliceH3Function: 'ICECHUNK_SLICE_H3',
    defaultBbox: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
  },
  {
    id: 'uk',
    label: '🇬🇧 UK 2km',
    description: 'Met Office UK Deterministic 2km — high-resolution UK + visibility',
    sliceH3Function: 'ICECHUNK_SLICE_H3_UK',
    defaultBbox: { latMin: 49, latMax: 61, lonMin: -11, lonMax: 2 },
  },
]

/** Variables available in the UK 2km dataset */
export const UK_VARIABLES: string[] = [
  'air_temperature',
  'lwe_precipitation_rate',
  'wind_speed_at_10m',
  'air_pressure_at_sea_level',
  'relative_humidity',
  'cloud_amount_of_total_cloud',
  'visibility_at_screen_level',
]
