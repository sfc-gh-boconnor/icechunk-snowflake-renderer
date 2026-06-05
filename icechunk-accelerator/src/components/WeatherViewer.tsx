import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PolygonLayer, SolidPolygonLayer } from '@deck.gl/layers'
import { H3HexagonLayer } from '@deck.gl/geo-layers'
import { PickingInfo } from '@deck.gl/core'
import MapView from '../shared/MapView'
import { sfQuery } from '../shared/helpers'
import {
  valueToRgba,
  formatValue,
  buildGradient,
  estimateCellCount,
  PALETTES,
  PaletteKey,
} from '../shared/format'
import {
  VARIABLES,
  VARIABLE_MAP,
  resolveVariableMeta,
  WeatherPoint,
  MetaResult,
  BBox,
  BBOX_PRESETS,
  GLOBAL_BBOX,
  UK_BBOX,
  Dataset,
  DATASETS,
  UK_VARIABLES,
} from '../types'

// ─────────────────────────────────────────────────────────────────────────────

const QUERY_DB = 'ICECHUNK_DB'
const QUERY_SCHEMA = 'ICECHUNK'
const MAX_CELLS = 1_500_000
// TARGET_UK_RAW: used for the Snowflake function path (H3 mode and small-area grid).
// Snowflake external functions have a hard 20 MB response cap (~400K cells max).
// UK grid mode for large areas uses the direct API path (/api/direct/slice_uk)
// which has no cap — TARGET_UK_RAW_DIRECT covers those calls.
const TARGET_UK_RAW        = 250_000    // Snowflake function path (grid H3 + small area grid)
const TARGET_UK_RAW_DIRECT = 1_200_000  // Direct API path (UK grid mode, no 20 MB cap)
// 3D level pre-fetch: keep per-level limit to avoid loading 33 levels × large
// grid into the browser level cache simultaneously.
const TARGET_UK_LEVEL_RAW = 300_000

/**
 * Map DeckGL zoom level to an H3 resolution that produces hex cells
 * roughly matching the on-screen grid spacing.
 *
 * H3 res 2 → ~1500km | res 3 → ~500km | res 4 → ~180km
 * res 5 → ~60km      | res 6 → ~20km  (best match for 10km Met Office grid)
 */
function zoomToH3Res(zoom: number): number {
  if (zoom <= 2) return 2
  if (zoom <= 4) return 3
  if (zoom <= 6) return 4
  if (zoom <= 8) return 5
  return 6
}

interface WeatherViewerProps {
  /** Called when the user clicks a point or requests to ask the agent about the current region. */
  onMapContext?: (message: string) => void
  /** Bbox from agent tool results — zooms and loads data for that region. */
  focusBbox?: { lat_min: number; lat_max: number; lon_min: number; lon_max: number } | null
  /** Called after focusBbox has been consumed so App can clear it. */
  onFocusConsumed?: () => void
}

export default function WeatherViewer({ onMapContext, focusBbox, onFocusConsumed }: WeatherViewerProps) {
  const [activeVar, setActiveVar] = useState('air_temperature')
  const [dataset, setDataset] = useState<Dataset>('global')
  const datasetCfg = DATASETS.find(d => d.id === dataset)!
  const [bbox, setBbox] = useState<BBox>(GLOBAL_BBOX)
  const [heightLevel, setHeightLevel] = useState(0)
  const [heightM, setHeightM] = useState<number | null>(null)
  const [totalLevels, setTotalLevels] = useState(33)
  // Pre-fetched level cache for 3D variables — keyed by level index.
  // Populated by prefetchAllLevels(); slider changes read from here (instant).
  const [levelCache, setLevelCache] = useState<Map<number, WeatherPoint[]>>(new Map())
  const [loadingLevels, setLoadingLevels] = useState(false)
  const [levelsLoaded, setLevelsLoaded] = useState(0)
  const prefetchGenRef = useRef(0)  // increment to cancel in-flight prefetch
  const [data, setData] = useState<WeatherPoint[]>([])
  const [meta, setMeta] = useState<MetaResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opacity, setOpacity] = useState(0.85)
  // 'h3' (default) uses ICECHUNK_SLICE_H3 — Python-aggregated, fewer rows, fastest
  // 'points' uses ICECHUNK_SLICE — raw grid points rendered as SolidPolygonLayer
  const [renderMode, setRenderMode] = useState<'h3' | 'points'>('h3')
  // 'auto' = use variable's built-in colorScale; anything else = override palette
  const [colorScheme, setColorScheme] = useState<PaletteKey>('auto')
  const [minVal, setMinVal] = useState(() => VARIABLE_MAP['air_temperature'].minHint)
  const [maxVal, setMaxVal] = useState(() => VARIABLE_MAP['air_temperature'].maxHint)
  const [snapshots, setSnapshots] = useState<Array<{ tag: string; label: string; snapshotId: string }>>([])  
  const [selectedSnapshot, setSelectedSnapshot] = useState<string | null>(null)

  // ── Save-to-table state ────────────────────────────────────────────────────
  const [tableName, setTableName] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<{ table: string; row_count: number } | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [pivoted, setPivoted] = useState(false)   // false = long format, true = wide/pivoted
  const tableInputRef = useRef<HTMLInputElement>(null)

  // ── Table analysis panel state ────────────────────────────────────────────
  const [tableViewOpen, setTableViewOpen] = useState(false)
  const [tablePreview, setTablePreview] = useState<Record<string, unknown>[]>([])
  const [tableStats, setTableStats] = useState<Record<string, unknown>[]>([])
  const [tableViewLoading, setTableViewLoading] = useState(false)
  const [tableViewTab, setTableViewTab] = useState<'preview' | 'stats'>('preview')

  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 20,
    zoom: 1.5,
    pitch: 0 as number,
    bearing: 0 as number,
  })

  // H3 resolution derived from current zoom — Snowflake H3_LATLNG_TO_CELL uses this
  const h3Res = zoomToH3Res(viewState.zoom)

  // Effective variable list:
  // - UK: uses UK_VARIABLES (surface + 3D height/pressure level vars)
  // Effective variable list:
  // - UK: filter UK_VARIABLES to those actually present in meta.variables
  //   (reflects what has been seeded). 3D vars are always kept since they may
  //   live in a snapshot that meta (main branch) doesn't enumerate.
  //   Falls back to showing all UK_VARIABLES while meta is still loading.
  // - Global: surface VARIABLES + cloud_amount_on_height_levels only.
  const availableVars = dataset === 'uk'
    ? UK_VARIABLES
        .filter(k => {
          const vm = resolveVariableMeta(k)
          if (vm.is3D) return true  // 3D vars always shown (may be in a snapshot)
          if (!meta?.variables?.length) return true  // meta not loaded yet — show all
          return meta.variables.includes(k)
        })
        .map(k => resolveVariableMeta(k))
    : VARIABLES.filter(v =>
        v.key !== 'visibility_at_screen_level' &&
        (!v.is3D || v.key === 'cloud_amount_on_height_levels')
      )

  const varMeta = useMemo(() => resolveVariableMeta(activeVar), [activeVar])

  // When meta loads, switch to the first available variable if the current one
  // isn't present in the repo:
  // - UK: if activeVar isn't in meta.variables (e.g. air_temperature not yet seeded),
  //   switch to the first surface UK var that IS in meta.variables.
  // - Global: only reset if var is unknown to both meta AND the static VARIABLES list
  //   (avoids resetting cloud_amount_on_height_levels which lives in a separate snapshot).
  useEffect(() => {
    if (!meta?.variables?.length) return
    if (dataset === 'uk') {
      if (!meta.variables.includes(activeVar) && !resolveVariableMeta(activeVar).is3D) {
        const firstAvailable = UK_VARIABLES.find(k => meta.variables.includes(k))
        if (firstAvailable) setActiveVar(firstAvailable)
      }
    } else {
      if (!meta.variables.includes(activeVar) && !VARIABLES.find(v => v.key === activeVar)) {
        setActiveVar(meta.variables[0])
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, dataset])

  // When dataset changes: zoom to its default bbox and validate active variable
  useEffect(() => {
    if (dataset === 'uk') {
      setBboxPreset(UK_BBOX)
      // Only reset if var is not known for UK at all; meta will handle seeded-var check
      if (!UK_VARIABLES.includes(activeVar)) setActiveVar(UK_VARIABLES[0])
    } else {
      if (activeVar === 'visibility_at_screen_level') setActiveVar('air_temperature')
    }
  }, [dataset])

  // Reset color range to hints when variable changes
  useEffect(() => {
    setMinVal(varMeta.minHint)
    setMaxVal(varMeta.maxHint)
  }, [activeVar, varMeta.minHint, varMeta.maxHint])

  // Auto-generate table name when bbox or snapshot changes
  // e.g. WEATHER_20260603_143022
  useEffect(() => {
    const now = new Date()
    const stamp = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + '_'
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0')
    setTableName(`WEATHER_${stamp}`)
    setSaveResult(null)
    setSaveError(null)
  }, [bbox, selectedSnapshot])

  // ── Load repo metadata and available snapshots on mount / dataset change ────
  // ── Reload metadata + snapshots (callable from UI after seeding) ─────────────
  const reloadMeta = useCallback(async () => {
    const metaSql = dataset === 'uk'
      ? `SELECT ${QUERY_DB}.${QUERY_SCHEMA}.ICECHUNK_META_UK() AS result`
      : `SELECT ${QUERY_DB}.${QUERY_SCHEMA}.ICECHUNK_META() AS result`
    try {
      const rows = await sfQuery(metaSql, QUERY_DB, QUERY_SCHEMA)
      if (rows.length > 0) {
        const raw = rows[0].RESULT ?? rows[0].result
        setMeta(typeof raw === 'string' ? JSON.parse(raw) : raw as MetaResult)
      }
    } catch { /* non-critical */ }
    try {
      const endpoint = dataset === 'uk' ? '/api/snapshots?dataset=uk' : '/api/snapshots'
      const res = await fetch(endpoint)
      if (res.ok) {
        const body = await res.json() as { snapshots: Array<{ tag: string; label: string; snapshotId: string }> }
        setSnapshots(body.snapshots ?? [])
      }
    } catch { /* non-critical */ }
  }, [dataset])

  useEffect(() => {
    const metaSql = dataset === 'uk'
      ? `SELECT ${QUERY_DB}.${QUERY_SCHEMA}.ICECHUNK_META_UK() AS result`
      : `SELECT ${QUERY_DB}.${QUERY_SCHEMA}.ICECHUNK_META() AS result`
    const loadMeta = async () => {
      const rows = await sfQuery(metaSql, QUERY_DB, QUERY_SCHEMA)
      if (rows.length > 0) {
        const raw = rows[0].RESULT ?? rows[0].result
        setMeta(typeof raw === 'string' ? JSON.parse(raw) : raw as MetaResult)
      }
    }
    const loadSnapshots = async () => {
      try {
        const endpoint = dataset === 'uk' ? '/api/snapshots?dataset=uk' : '/api/snapshots'
        const res = await fetch(endpoint)
        if (res.ok) {
          const body = await res.json() as { snapshots: Array<{ tag: string; label: string; snapshotId: string }> }
          setSnapshots(body.snapshots ?? [])
        }
      } catch { /* non-critical */ }
    }
    setMeta(null); setSnapshots([]); setSelectedSnapshot(null); setData([])
    loadMeta()
    loadSnapshots()
  }, [dataset])

  // ── Row → WeatherPoint mapping (shared by fetchData and prefetchAllLevels) ──
  const mapRowsToPoints = useCallback((rows: Record<string, unknown>[]): WeatherPoint[] => {
    return rows.map(r => {
      const isH3Cloud = varMeta.is3D && renderMode === 'h3'
      const isUk3D    = varMeta.is3D && dataset === 'uk'
      const raw = isH3Cloud
        ? Number(r.VALUE ?? r.value ?? 0)
        : varMeta.is3D && !isUk3D
        ? Number(r.CLOUD_PCT ?? r.cloud_pct ?? 0)
        : Number(r.VALUE ?? r.value ?? 0)
      const lv = r.LEVEL_VALUE ?? r.level_value ?? r.HEIGHT_M ?? r.height_m
      const lu = r.LEVEL_UNITS ?? r.level_units
      return {
        lat:         Number(r.LAT ?? r.lat),
        lon:         Number(r.LON ?? r.lon),
        h3index:     r.H3INDEX != null ? String(r.H3INDEX) : r.h3index != null ? String(r.h3index) : undefined,
        value:       varMeta.transform(raw),
        cloud_pct:   r.CLOUD_PCT != null ? Number(r.CLOUD_PCT) : r.cloud_pct != null ? Number(r.cloud_pct) : undefined,
        height_m:    lv != null ? Number(lv) : undefined,
        level_units: lu != null ? String(lu) : undefined,
      }
    })
  }, [varMeta, renderMode, dataset])

  // ── Build SQL for a single 3D level (used by prefetchAllLevels) ───────────
  const buildLevel3dSql = useCallback((level: number): string => {
    // Only use a snapshot ID if it belongs to the current dataset's snapshot list.
    // Prevents stale global snapshots being passed to UK endpoints (and vice versa).
    const validSnapshot = selectedSnapshot && snapshots.find(s => s.snapshotId === selectedSnapshot)
      ? selectedSnapshot : null
    const snapExpr = validSnapshot ? `'${validSnapshot}'` : 'NULL'
    if (renderMode === 'h3') {
      const fn = dataset === 'uk' ? 'ICECHUNK_LEVEL_SLICE_H3_UK' : 'ICECHUNK_CLOUD_AT_LEVEL_H3'
      return dataset === 'uk'
        ? `SELECT f.value:h3index::VARCHAR AS h3index,
                  f.value:value::FLOAT     AS value,
                  f.value:level_value::FLOAT AS level_value,
                  f.value:level_units::VARCHAR AS level_units,
                  r.result:total_levels::INTEGER AS total_levels
           FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.${fn}(
             '${activeVar}', ${level}, ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}, ${h3Res}
           ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`
        : `SELECT f.value:h3index::VARCHAR    AS h3index,
                  f.value:value::FLOAT        AS value,
                  f.value:height_m::FLOAT     AS level_value,
                  r.result:total_levels::INTEGER AS total_levels
           FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.${fn}(
             ${level}, ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}, ${h3Res}
           ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`
    } else {
      // Grid mode
      const fn = dataset === 'uk' ? 'ICECHUNK_LEVEL_SLICE_UK' : 'ICECHUNK_CLOUD_AT_LEVEL'
      return dataset === 'uk'
        ? `SELECT f.value:lat::FLOAT AS lat, f.value:lon::FLOAT AS lon,
                  f.value:value::FLOAT AS value,
                  f.value:level_value::FLOAT AS level_value,
                  f.value:level_units::VARCHAR AS level_units,
                  r.result:total_levels::INTEGER AS total_levels
           FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.${fn}(
             '${activeVar}', ${level}, ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}
           ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`
        : `SELECT f.value:lat::FLOAT AS lat, f.value:lon::FLOAT AS lon,
                  f.value:cloud_pct::FLOAT AS cloud_pct,
                  f.value:height_m::FLOAT AS level_value,
                  r.result:total_levels::INTEGER AS total_levels
           FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.${fn}(
             ${level}, ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}
           ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`
    }
  }, [activeVar, bbox, selectedSnapshot, snapshots, renderMode, h3Res, dataset])

  // ── Pre-fetch ALL levels for 3D variables ─────────────────────────────────
  // Fires all N level queries in parallel (up to 8 concurrent).
  // Grid mode: cache key excludes h3Res (zoom doesn't change grid data).
  // H3 mode:   cache key includes h3Res (zoom changes cell size).
  const prefetchAllLevels = useCallback(async () => {
    if (!varMeta?.is3D || !meta) return

    const gen = ++prefetchGenRef.current
    setLevelCache(new Map())
    setLevelsLoaded(0)
    setLoadingLevels(true)
    setError(null)
    let loaded = 0  // local count (avoids stale state closure)

    // Fetch level 0 first to discover total_levels
    let nLevels = totalLevels
    try {
      const rows0 = await sfQuery(buildLevel3dSql(0), QUERY_DB, QUERY_SCHEMA)
      if (prefetchGenRef.current !== gen) return  // superseded
      if (rows0.length > 0) {
        const tl = Number((rows0[0] as Record<string, unknown>).TOTAL_LEVELS ?? (rows0[0] as Record<string, unknown>).total_levels)
        if (tl > 0) { nLevels = tl; setTotalLevels(tl) }
        const pts0 = mapRowsToPoints(rows0)
        if (pts0.length > 0 && pts0[0].height_m != null) setHeightM(pts0[0].height_m)
        setLevelCache(prev => new Map(prev).set(0, pts0))
        setLevelsLoaded(1)
        loaded = 1
      }
    } catch (err) {
      // If snapshot doesn't have this 3D var, fall back to main branch
      if (String(err).includes('Unknown variable') && selectedSnapshot) {
        setSelectedSnapshot(null)
        setLoadingLevels(false)
        setError('Snapshot switched to Latest — press ↺ Refresh to load.')
        return
      }
      /* level 0 failed */ }

    // Fetch remaining levels in parallel, batched 8 at a time
    const BATCH = 8
    for (let start = 1; start < nLevels; start += BATCH) {
      if (prefetchGenRef.current !== gen) return
      const batch = Array.from({ length: Math.min(BATCH, nLevels - start) }, (_, i) => start + i)
      await Promise.all(batch.map(async (lvl) => {
        try {
          const rows = await sfQuery(buildLevel3dSql(lvl), QUERY_DB, QUERY_SCHEMA)
          if (prefetchGenRef.current !== gen) return
          const pts = mapRowsToPoints(rows)
          setLevelCache(prev => new Map(prev).set(lvl, pts))
          setLevelsLoaded(prev => prev + 1)
          loaded++
        } catch { /* skip failed levels silently */ }
      }))
    }

    setLoadingLevels(false)

    // Surface a helpful error if nothing loaded at all
    if (prefetchGenRef.current === gen && loaded === 0) {
      const hint = dataset === 'global' && activeVar === 'cloud_amount_on_height_levels'
        ? 'Cloud by height requires the cloud snapshot — select it from the Snapshot picker (top-right).'
        : 'No data found for this variable in the current snapshot.'
      setError(hint)
    }
  }, [varMeta, meta, buildLevel3dSql, mapRowsToPoints, totalLevels, dataset, activeVar])

  // When a 3D variable is active and cache deps change → prefetch all levels
  // Grid mode: h3Res excluded (zoom doesn't change grid data)
  // H3 mode:   h3Res included (zoom changes cell size)
  const level3dCacheKey = varMeta.is3D
    ? `${dataset}|${activeVar}|${bbox.latMin}|${bbox.latMax}|${bbox.lonMin}|${bbox.lonMax}|${selectedSnapshot}|${renderMode === 'h3' ? h3Res : 'grid'}`
    : ''

  // ── Manual refresh (no auto-fetch on bbox/variable/snapshot changes) ─────────
  // Data only loads when the user clicks "Load / Refresh".
  // This prevents hammering the backend on every pan, zoom, or setting change.
  // handleRefresh defined below (after fetchData is declared)

  // When heightLevel changes on a 3D var, read from cache (instant, no re-fetch)
  useEffect(() => {
    if (!varMeta.is3D) return
    const cached = levelCache.get(heightLevel)
    if (cached) {
      setData(cached)
      if (cached.length > 0) {
        let mn = cached[0].value, mx = cached[0].value
        for (const p of cached) { if (p.value < mn) mn = p.value; if (p.value > mx) mx = p.value }
        setMinVal(mn); setMaxVal(mx)
        if (cached[0].height_m != null) setHeightM(cached[0].height_m)
      }
    }
  }, [heightLevel, levelCache, varMeta.is3D])

  // ── Fetch weather data (2D variables only — 3D is handled by prefetchAllLevels) ─
  const fetchData = useCallback(async () => {
    if (!varMeta) return
    if (!meta) return
    if (varMeta.is3D) return  // 3D handled by prefetchAllLevels
    // For UK grid mode use the actual ~2km spacing to estimate cell count;
    // the global estimator uses 10km spacing and underestimates by ~25x.
    const ukGrid = dataset === 'uk' && renderMode === 'points'
    const latStepLocal = meta?.grid
      ? (meta.grid.lat_range[1] - meta.grid.lat_range[0]) / (meta.grid.lat_count - 1)
      : (dataset === 'uk' ? 0.019 : 0.09)
    const lonStepLocal = meta?.grid
      ? (meta.grid.lon_range[1] - meta.grid.lon_range[0]) / (meta.grid.lon_count - 1)
      : (dataset === 'uk' ? 0.032 : 0.09)
    const cellCount = ukGrid
      ? Math.ceil((bbox.latMax - bbox.latMin) / latStepLocal) *
        Math.ceil((bbox.lonMax - bbox.lonMin) / lonStepLocal)
      : estimateCellCount(bbox.latMin, bbox.latMax, bbox.lonMin, bbox.lonMax)
    // Backend auto-strides large UK requests.
    // UK grid mode uses the direct API path (no 20 MB Snowflake cap) → TARGET_UK_RAW_DIRECT.
    // UK H3 mode uses Snowflake function path → TARGET_UK_RAW.
    const effectiveTarget = ukGrid ? TARGET_UK_RAW_DIRECT : TARGET_UK_RAW
    const stride = ukGrid && cellCount > effectiveTarget
      ? Math.max(1, Math.ceil(Math.sqrt(cellCount / effectiveTarget)))
      : 1
    const effectiveCells = ukGrid ? Math.ceil(cellCount / (stride * stride)) : cellCount
    // Only block global queries that are truly enormous; UK grid mode is unrestricted.
    if (!ukGrid && effectiveCells > MAX_CELLS) {
      setError(`Selection too large (~${cellCount.toLocaleString()} cells). Narrow your bounding box.`)
      return
    }
    setError(null)
    setLoading(true)
    try {
      let rows: Record<string, unknown>[]
      // Only use a snapshot if it belongs to the current dataset's snapshot list
      const validSnap = selectedSnapshot && snapshots.find(s => s.snapshotId === selectedSnapshot)
        ? selectedSnapshot : null
      const snapExpr = validSnap ? `'${validSnap}'` : 'NULL'

      if (varMeta.is3D && renderMode === 'h3') {
        // 3D level H3 — generic endpoint handles cloud, temp, wind on height OR pressure levels
        const levelH3Fn = dataset === 'uk' ? 'ICECHUNK_LEVEL_SLICE_H3_UK' : 'ICECHUNK_CLOUD_AT_LEVEL_H3'
        const sql3d = dataset === 'uk'
          ? `SELECT f.value:h3index::VARCHAR AS h3index,
                    f.value:value::FLOAT     AS value,
                    f.value:level_value::FLOAT AS level_value,
                    f.value:level_units::VARCHAR AS level_units,
                    r.result:total_levels::INTEGER AS total_levels
             FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.${levelH3Fn}(
               '${activeVar}', ${heightLevel}, ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}, ${h3Res}
             ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`
          : `SELECT f.value:h3index::VARCHAR    AS h3index,
                    f.value:value::FLOAT        AS value,
                    f.value:height_m::FLOAT     AS level_value,
                    r.result:total_levels::INTEGER AS total_levels
             FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.${levelH3Fn}(
               ${heightLevel}, ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}, ${h3Res}
             ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`
        rows = await sfQuery(sql3d, QUERY_DB, QUERY_SCHEMA)
      } else if (varMeta.is3D) {
        // 3D level scatter — generic endpoint
        const levelFn = dataset === 'uk' ? 'ICECHUNK_LEVEL_SLICE_UK' : 'ICECHUNK_CLOUD_AT_LEVEL'
        const sqlScatter = dataset === 'uk'
          ? `SELECT f.value:lat::FLOAT AS lat, f.value:lon::FLOAT AS lon,
                    f.value:value::FLOAT AS value,
                    f.value:level_value::FLOAT AS level_value,
                    f.value:level_units::VARCHAR AS level_units,
                    r.result:total_levels::INTEGER AS total_levels
             FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.${levelFn}(
               '${activeVar}', ${heightLevel}, ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}
             ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`
          : `SELECT f.value:lat::FLOAT AS lat, f.value:lon::FLOAT AS lon,
                    f.value:cloud_pct::FLOAT AS cloud_pct,
                    f.value:height_m::FLOAT AS level_value,
                    r.result:total_levels::INTEGER AS total_levels
             FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.${levelFn}(
               ${heightLevel}, ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}
             ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`
        rows = await sfQuery(sqlScatter, QUERY_DB, QUERY_SCHEMA)
      } else if (dataset === 'uk' && renderMode === 'points') {
        // UK 2km grid — direct API path (bypasses Snowflake 20 MB external function cap).
        // Returns the full ~1M native 2km cells for country-scale views.
        const directRes = await fetch('/api/direct/slice_uk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            variable:    activeVar,
            lat_min:     bbox.latMin,
            lat_max:     bbox.latMax,
            lon_min:     bbox.lonMin,
            lon_max:     bbox.lonMax,
            snapshot_id: validSnap ?? null,
          }),
        })
        if (!directRes.ok) {
          const errBody = await directRes.json().catch(() => ({ error: directRes.statusText }))
          const errMsg = String((errBody as {error?: string}).error ?? directRes.statusText)
          if (errMsg.includes('Unknown variable') && selectedSnapshot) {
            setSelectedSnapshot(null)
            setError('Snapshot switched to Latest — press ↺ Refresh to load.')
            return
          }
          throw new Error(errMsg)
        }
        const directData = await directRes.json() as { data: Record<string, unknown>[] }
        rows = directData.data ?? []
      } else if (dataset === 'uk') {
        // UK 2km — H3 aggregated (default, fewer rows)
        rows = await sfQuery(
          `SELECT f.value:h3index::VARCHAR AS h3index,
                  f.value:value::FLOAT AS value
           FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.ICECHUNK_SLICE_H3_UK(
             '${activeVar}', ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}, ${h3Res}
           ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`,
          QUERY_DB,
          QUERY_SCHEMA
        )
      } else if (renderMode === 'h3') {
        rows = await sfQuery(
          `SELECT f.value:h3index::VARCHAR AS h3index,
                  f.value:value::FLOAT AS value
           FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.ICECHUNK_SLICE_H3(
             '${activeVar}', ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}, ${h3Res}
           ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`,
          QUERY_DB,
          QUERY_SCHEMA
        )
      } else {
        rows = await sfQuery(
          `SELECT f.value:lat::FLOAT AS lat,
                  f.value:lon::FLOAT AS lon,
                  f.value:value::FLOAT AS value
           FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.ICECHUNK_SLICE(
             '${activeVar}', ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}
           ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`,
          QUERY_DB,
          QUERY_SCHEMA
        )
      }

      const points = mapRowsToPoints(rows)

      if (points.length > 0) {
        let computedMin = points[0].value
        let computedMax = points[0].value
        for (const p of points) {
          if (p.value < computedMin) computedMin = p.value
          if (p.value > computedMax) computedMax = p.value
        }
        setMinVal(computedMin)
        setMaxVal(computedMax)
      }
      setData(points)
    } catch (err) {
      const errMsg = String(err)
      // If the selected snapshot doesn't contain the requested variable,
      // automatically fall back to the main branch and tell the user to re-run.
      if (errMsg.includes('Unknown variable') && selectedSnapshot) {
        setSelectedSnapshot(null)
        setError('Snapshot switched to Latest — press ↺ Refresh to load.')
        return
      }
      setError(errMsg)
    } finally {
      setLoading(false)
    }
  }, [activeVar, bbox, varMeta, selectedSnapshot, snapshots, meta, h3Res, renderMode, dataset, mapRowsToPoints])

  // Auto-fetch removed — use handleRefresh() / the Load button instead.

  // ── Manual refresh handler ────────────────────────────────────────────────
  // Data only loads when the user presses "Load / Refresh". Prevents hammering
  // the backend on every pan, zoom, or setting change.
  const handleRefresh = useCallback(() => {
    if (varMeta.is3D && meta) prefetchAllLevels()
    else fetchData()
  }, [varMeta, meta, prefetchAllLevels, fetchData])

  // ── Build deck.gl layers ───────────────────────────────────────────────────
  const bboxPolygon = [
    [bbox.lonMin, bbox.latMin],
    [bbox.lonMax, bbox.latMin],
    [bbox.lonMax, bbox.latMax],
    [bbox.lonMin, bbox.latMax],
    [bbox.lonMin, bbox.latMin],
  ]

  // When a layer item is clicked, build a context message for the agent
  const handleLayerClick = useCallback((info: PickingInfo) => {
    if (!info.object || !onMapContext) return
    const d = info.object as WeatherPoint
    if (!d.lat && d.lat !== 0) return
    const displayVal = formatValue(d.value, activeVar)
    const msg = `Tell me about the weather at lat ${d.lat.toFixed(4)}, lon ${d.lon.toFixed(4)}.\n` +
                `${varMeta.label}: ${displayVal}\n` +
                `What does this value mean and how does it compare to the surrounding area?`
    onMapContext(msg)
  }, [activeVar, varMeta, onMapContext])

  // Layer depends on both varMeta.is3D and renderMode:
  // - 3D cloud → ScatterplotLayer (dots)
  // - 2D + H3 mode → H3HexagonLayer (h3index comes from Python backend)
  // - 2D + grid mode → SolidPolygonLayer (degree-based rectangles matching native grid spacing)
  //
  // Grid step is derived from metadata (lat_count, lon_count, lat_range, lon_range).
  // Falls back to known dataset defaults while meta is still loading.
  const latStep = meta?.grid
    ? (meta.grid.lat_range[1] - meta.grid.lat_range[0]) / (meta.grid.lat_count - 1)
    : (dataset === 'uk' ? 0.019 : 0.09)
  const lonStep = meta?.grid
    ? (meta.grid.lon_range[1] - meta.grid.lon_range[0]) / (meta.grid.lon_count - 1)
    : (dataset === 'uk' ? 0.032 : 0.09)

  // Auto-stride: backend subsamples the UK grid to keep under the target count.
  // UK grid mode (surface 2D) goes via the direct API → no 20 MB cap → larger target.
  // UK H3 mode goes via Snowflake function → lower target (aggregated cells are small).
  // 3D level pre-fetch uses TARGET_UK_LEVEL_RAW to keep 33-level cache manageable.
  const isUkDirectPath = dataset === 'uk' && renderMode === 'points' && !varMeta.is3D
  const ukTarget = varMeta.is3D
    ? TARGET_UK_LEVEL_RAW
    : (isUkDirectPath ? TARGET_UK_RAW_DIRECT : TARGET_UK_RAW)
  const ukEstimate = dataset === 'uk' && renderMode === 'points'
    ? Math.ceil((bbox.latMax - bbox.latMin) / latStep) *
      Math.ceil((bbox.lonMax - bbox.lonMin) / lonStep)
    : 0
  const ukStride = ukEstimate > ukTarget
    ? Math.max(1, Math.ceil(Math.sqrt(ukEstimate / ukTarget)))
    : 1

  // Multiply by 1.015 (global) / 1.001 (UK) to fill hairline gaps between cells.
  // Global: WebGL sub-pixel gaps show the dark basemap → need more overlap.
  // UK: curvilinear cells tile tightly already → minimal overlap avoids white seams.
  const overlap = dataset === 'uk' ? 1.001 : 1.015
  const halfDegLat = (latStep / 2) * (dataset === 'uk' ? ukStride : 1) * overlap
  const halfDegLon = (lonStep / 2) * (dataset === 'uk' ? ukStride : 1) * overlap

  // Active colour scale — override with named palette if selected
  const activeColorScale = colorScheme === 'auto'
    ? varMeta.colorScale
    : PALETTES[colorScheme as Exclude<PaletteKey, 'auto'>].scale

  // Layer selection:
  // - 3D cloud + H3 mode   → H3HexagonLayer (cloud fraction aggregated to H3 cells)
  // - 3D cloud + grid mode → SolidPolygonLayer (same grid-cell rectangles as 2D)
  // - 2D + H3 mode         → H3HexagonLayer (h3index from Python backend)
  // - 2D + grid mode       → SolidPolygonLayer (degree-based rectangles)
  const weatherLayer = varMeta.is3D && renderMode === 'h3'
    ? new H3HexagonLayer<WeatherPoint>({
        id: 'weather-cloud-h3',
        data,
        getHexagon: d => d.h3index ?? '',
        getFillColor: d => valueToRgba(d.value, minVal, maxVal, activeColorScale),
        getLineColor: [0, 0, 0, 0],
        filled: true,
        extruded: false,
        coverage: 1.001,
        pickable: true,
        onClick: handleLayerClick,
        opacity,
        updateTriggers: {
          getFillColor: [minVal, maxVal, activeVar, heightLevel, colorScheme],
          getHexagon:   [h3Res],
        },
      })
    : varMeta.is3D
    ? new SolidPolygonLayer<WeatherPoint>({
        id: 'weather-cloud-grid',
        data,
        getPolygon: d => [
          [d.lon - halfDegLon, d.lat - halfDegLat],
          [d.lon + halfDegLon, d.lat - halfDegLat],
          [d.lon + halfDegLon, d.lat + halfDegLat],
          [d.lon - halfDegLon, d.lat + halfDegLat],
        ],
        getFillColor: d => valueToRgba(d.value, minVal, maxVal, activeColorScale),
        getLineColor: [0, 0, 0, 0],
        pickable: true,
        onClick: handleLayerClick,
        opacity,
        updateTriggers: {
          getFillColor: [minVal, maxVal, activeVar, heightLevel, colorScheme],
          getPolygon:   [dataset],
        },
      })
    : renderMode === 'points'
    ? new SolidPolygonLayer<WeatherPoint>({
        id: 'weather-grid',
        data,
        // Each polygon is the actual lat/lon cell rectangle for that grid point.
        // halfDegLat/Lon are derived from the grid's degree-spacing so the cells
        // tile seamlessly and correctly show rectangles at high latitudes (real shape).
        getPolygon: d => [
          [d.lon - halfDegLon, d.lat - halfDegLat],
          [d.lon + halfDegLon, d.lat - halfDegLat],
          [d.lon + halfDegLon, d.lat + halfDegLat],
          [d.lon - halfDegLon, d.lat + halfDegLat],
        ],
        getFillColor: d => valueToRgba(d.value, minVal, maxVal, activeColorScale),
        getLineColor: [0, 0, 0, 0],
        pickable: true,
        onClick: handleLayerClick,
        opacity,
        updateTriggers: {
          getFillColor: [minVal, maxVal, activeVar, heightLevel, colorScheme],
          getPolygon:   [dataset],
        },
      })
    : new H3HexagonLayer<WeatherPoint>({
        id: 'weather-h3',
        data,
        // h3index is pre-computed by the Python backend in ICECHUNK_SLICE_H3
        // — no client-side h3-js needed, no SQL H3 functions per row
        getHexagon: d => d.h3index ?? '',
        getFillColor: d => valueToRgba(d.value, minVal, maxVal, activeColorScale),
        getLineColor: [0, 0, 0, 0],
        filled: true,
        extruded: false,
        coverage: 1.001,
        pickable: true,
        onClick: handleLayerClick,
        opacity,
        updateTriggers: {
          getFillColor: [minVal, maxVal, activeVar, heightLevel, colorScheme],
          getHexagon:   [h3Res],
        },
      })

  const bboxLayer = new PolygonLayer({
    id: 'bbox-outline',
    data: [{ polygon: bboxPolygon }],
    getPolygon: (d: { polygon: number[][] }) => d.polygon,
    getFillColor: [41, 181, 232, 20],
    getLineColor: [41, 181, 232, 180],
    getLineWidth: 2,
    lineWidthUnits: 'pixels',
    pickable: false,
  })

  // ── Tooltip handler ────────────────────────────────────────────────────────
  const getTooltip = useCallback((info: PickingInfo) => {
    if (!info.object) return null
    const d = info.object as WeatherPoint
    return {
      html: `
        <div style="font-weight:600">${varMeta.label}</div>
        <div>${formatValue(d.value, activeVar)}</div>
        ${d.height_m != null ? `<div style="color:#8A9BB0;font-size:11px">Height: ${d.height_m}m</div>` : ''}
        <div style="color:#8A9BB0;font-size:11px">${d.lat.toFixed(4)}°, ${d.lon.toFixed(4)}°</div>
        ${d.h3index ? `<div style="color:#8A9BB0;font-size:10px">H3 res ${h3Res}</div>` : ''}
        ${renderMode === 'points' && !d.h3index ? `<div style="color:#8A9BB0;font-size:10px">${dataset === 'uk' ? '~2km' : '~10km'} grid cell</div>` : ''}
        ${onMapContext ? `<div style="color:#29B5E8;font-size:10px;margin-top:3px">Click to ask agent ✦</div>` : ''}
      `,
      className: 'deck-tooltip',
    }
  }, [activeVar, varMeta, h3Res, renderMode, onMapContext])

  // ── Viewport → bbox helper ─────────────────────────────────────────────────
  const useViewportAsBbox = () => {
    const zoom = viewState.zoom
    const latSpan = 360 / Math.pow(2, zoom) * 0.5
    const lonSpan = 360 / Math.pow(2, zoom)
    setBbox({
      latMin: Math.max(-89, viewState.latitude - latSpan),
      latMax: Math.min(89, viewState.latitude + latSpan),
      lonMin: Math.max(-179, viewState.longitude - lonSpan),
      lonMax: Math.min(179, viewState.longitude + lonSpan),
    })
  }

  // Fly the map to a bounding box preset
  const setBboxPreset = (preset: BBox) => {
    setBbox(preset)
    const centerLat = (preset.latMin + preset.latMax) / 2
    const centerLon = (preset.lonMin + preset.lonMax) / 2
    // Compute zoom so the bbox fits comfortably in the viewport.
    // log2(360 / span) gives the zoom where span fills ~360° of screen;
    // subtract 0.8 to leave a small margin around the region.
    const latSpan = preset.latMax - preset.latMin
    const lonSpan = preset.lonMax - preset.lonMin
    const zoom = Math.max(1, Math.log2(360 / Math.max(latSpan, lonSpan)) - 0.8)
    setViewState(vs => ({ ...vs, longitude: centerLon, latitude: centerLat, zoom }))
  }

  // Groups for the preset dropdown
  const presetGroups = Array.from(new Set(BBOX_PRESETS.map(p => p.group)))

  // When the agent emits a map_focus event, zoom the map to that region
  useEffect(() => {
    if (!focusBbox) return
    setBboxPreset({
      latMin: focusBbox.lat_min,
      latMax: focusBbox.lat_max,
      lonMin: focusBbox.lon_min,
      lonMax: focusBbox.lon_max,
    })
    onFocusConsumed?.()
  }, [focusBbox])

  const isUkGrid = dataset === 'uk' && renderMode === 'points'
  const ukRawEstimate = isUkGrid
    ? Math.ceil((bbox.latMax - bbox.latMin) / latStep) *
      Math.ceil((bbox.lonMax - bbox.lonMin) / lonStep)
    : 0
  // Use the direct-path target for display stride when applicable (no 20 MB cap)
  const displayTarget = (isUkGrid && !varMeta.is3D) ? TARGET_UK_RAW_DIRECT : ukTarget
  const displayStride = ukRawEstimate > displayTarget
    ? Math.max(1, Math.ceil(Math.sqrt(ukRawEstimate / displayTarget)))
    : 1
  const cellCount = isUkGrid
    ? Math.ceil(ukRawEstimate / (displayStride * displayStride))
    : estimateCellCount(bbox.latMin, bbox.latMax, bbox.lonMin, bbox.lonMax)

  // ── Save to Snowflake table ───────────────────────────────────────────────
  const variableKeys = meta?.variables?.length ? meta.variables : VARIABLES.map(v => v.key)

  const handleSaveTable = async () => {
    if (!tableName.trim()) return
    setSaving(true)
    setSaveResult(null)
    setSaveError(null)
    try {
      const res = await fetch('/api/save-table', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_name: tableName.trim(),
          lat_min:     bbox.latMin,
          lat_max:     bbox.latMax,
          lon_min:     bbox.lonMin,
          lon_max:     bbox.lonMax,
          snapshot_id: selectedSnapshot ?? null,
          variables:   variableKeys.filter(v => !v.startsWith('cloud_amount_on_height')),
          pivoted,
          dataset,
        }),
      })
      const isJson = res.headers.get('content-type')?.includes('application/json')
      const body = isJson
        ? await res.json() as { table?: string; row_count?: number; error?: string }
        : { error: await res.text() }
      if (!res.ok) { setSaveError(body.error ?? 'Unknown error'); return }
      setSaveResult({ table: body.table!, row_count: body.row_count ?? 0 })
    } catch (err) {
      setSaveError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleCopyTable = () => {
    if (!saveResult) return
    navigator.clipboard.writeText(saveResult.table).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // ── Fetch preview + stats for the table analysis panel ──────────────────────
  const fetchTableView = async (tableFqn: string) => {
    setTableViewLoading(true)
    setTableViewOpen(true)
    setTableViewTab('preview')
    setTablePreview([])
    setTableStats([])
    try {
      const [previewRows, statsRows] = await Promise.all([
        sfQuery(`SELECT * FROM ${tableFqn} LIMIT 200`, QUERY_DB, QUERY_SCHEMA),
        sfQuery(
          `SELECT variable,
                  COUNT(*)         AS n,
                  MIN(value)       AS min_val,
                  MAX(value)       AS max_val,
                  AVG(value)       AS avg_val,
                  STDDEV(value)    AS std_val
           FROM ${tableFqn}
           GROUP BY variable
           ORDER BY variable`,
          QUERY_DB, QUERY_SCHEMA
        ),
      ])
      setTablePreview(previewRows)
      setTableStats(statsRows)
    } catch { /* non-critical */ }
    setTableViewLoading(false)
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="map-outer">
      <MapView
        layers={[weatherLayer, bboxLayer]}
        initialViewState={viewState}
        getTooltip={getTooltip}
        onViewStateChange={({ viewState: vs }) => {
          setViewState(vs as typeof viewState)
        }}
      />

      {/* Loading overlay */}
      {loading && (
        <div className="map-loading">
          <div className="spinner" />
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="map-overlay top-right" style={{ maxWidth: 280 }}>
          <div style={{ color: 'var(--red)', fontSize: 12 }}>⚠ {error}</div>
        </div>
      )}
      <div className="map-overlay top-left">
        {/* Dataset toggle */}
        <div style={{ marginBottom: 10 }}>
          <div className="overlay-title" style={{ marginBottom: 4 }}>Dataset</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {DATASETS.map(d => (
              <button
                key={d.id}
                className={`btn small ${dataset === d.id ? 'primary' : 'secondary'}`}
                style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
                onClick={() => setDataset(d.id as Dataset)}
                title={d.description}
              >
                {d.label}
              </button>
            ))}
          </div>
          {dataset === 'uk' && (
            <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 3 }}>
              ~2km resolution · UK only · includes visibility
            </div>
          )}
        </div>

        <div className="overlay-title">Variable</div>

        <div className="form-group" style={{ marginBottom: 12 }}>
          <select
            className="form-select"
            value={activeVar}
            onChange={e => { setActiveVar(e.target.value); setData([]) }}
          >
            {availableVars.map(v => (
              <option key={v.key} value={v.key}>
                {v.label}{v.is3D ? ' (3D)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group" style={{ marginBottom: varMeta.is3D ? 12 : 0 }}>
          <label className="form-label">Opacity: {Math.round(opacity * 100)}%</label>
          <input
            type="range" min={0.1} max={1} step={0.05}
            value={opacity}
            onChange={e => setOpacity(Number(e.target.value))}
          />
        </div>

        {/* Height / pressure level slider — only for 3D variables */}
        {varMeta.is3D && (
          <div>
            <div className="overlay-title" style={{ marginTop: 4 }}>
              {activeVar.endsWith('_on_pressure_levels') ? 'Pressure Level' : 'Height Level'}
            </div>
            <div className="height-display">
              {heightM != null ? (
                <>
                  {activeVar.endsWith('_on_pressure_levels')
                    ? `${(heightM / 100).toFixed(0)} hPa`
                    : heightM < 1000
                    ? `${heightM.toFixed(0)}m`
                    : `${(heightM / 1000).toFixed(1)}km`}
                  <small> level {heightLevel}/{totalLevels - 1}</small>
                </>
              ) : (
                <>Level {heightLevel}<small>/{totalLevels - 1}</small></>
              )}
            </div>
            <input
              type="range" min={0} max={totalLevels - 1} step={1}
              value={heightLevel}
              onChange={e => setHeightLevel(Number(e.target.value))}
              style={{ margin: '4px 0' }}
            />
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 10, color: 'var(--text-secondary)',
            }}>
              {activeVar.endsWith('_on_pressure_levels')
                ? <><span>Surface (1000 hPa)</span><span>Upper atm (10 hPa)</span></>
                : <><span>Surface (~5m)</span><span>Upper (~40km)</span></>
              }
            </div>
            {/* Level cache loading progress */}
            {loadingLevels && (
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 3 }}>
                  Pre-loading levels… {levelsLoaded}/{totalLevels}
                </div>
                <div style={{ height: 3, background: 'var(--surface-2)', borderRadius: 2 }}>
                  <div style={{
                    height: '100%',
                    width: `${(levelsLoaded / totalLevels) * 100}%`,
                    background: 'var(--accent)',
                    borderRadius: 2,
                    transition: 'width 0.2s ease',
                  }} />
                </div>
              </div>
            )}
            {!loadingLevels && levelCache.size > 0 && (
              <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 4 }}>
                ✓ {levelCache.size} levels cached — slider is instant
              </div>
            )}
          </div>
        )}

        {/* Render mode toggle — H3 hexagons vs raw dots/grid */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <button
            className={`btn small ${renderMode === 'h3' ? 'primary' : 'secondary'}`}
            style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
            onClick={() => { setRenderMode('h3'); setData([]) }}
            title="H3 hexagons — Python aggregation, faster"
          >
            ⬡ H3
          </button>
          <button
            className={`btn small ${renderMode === 'points' ? 'primary' : 'secondary'}`}
            style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
            onClick={() => { setRenderMode('points'); setData([]) }}
            title={`Native grid cells (${dataset === 'uk' ? '~2km squares' : '~10km squares'})`}
          >
            ▦ Grid
          </button>
        </div>

        {/* Load / Refresh button — data only loads on demand */}
        <button
          className="btn primary"
          style={{ width: '100%', justifyContent: 'center', marginBottom: 8,
                   fontWeight: 600, fontSize: 12, letterSpacing: '0.02em' }}
          onClick={handleRefresh}
          disabled={loading || loadingLevels || !meta}
          title="Load data for current bbox, variable and settings"
        >
          {loading || loadingLevels ? '⏳ Loading…' : '↺ Load / Refresh'}
        </button>

        {/* Point count */}
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
          {data.length > 0
            ? `${data.length.toLocaleString()} ${
                renderMode === 'h3'
                  ? 'H3 cells'
                  : varMeta.is3D
                  ? '10km scatter pts'
                  : dataset === 'uk' ? '2km grid cells' : '10km grid cells'
              }`
            : loading ? 'Loading…' : 'No data'}
          {renderMode === 'h3' && data.length > 0 && (
            <span style={{ marginLeft: 6 }}>res {h3Res}</span>
          )}
        </div>
      </div>

      {/* ── Snapshot / date selector ──────────────────────── */}
      {meta && (
        <div className="map-overlay top-right" style={{ padding: '8px 12px', minWidth: 220 }}>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Snapshot
          </div>

          {snapshots.length > 0 ? (
            <>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <select
                  className="form-select"
                  style={{ fontSize: 12, padding: '4px 8px', flex: 1 }}
                  value={selectedSnapshot ?? ''}
                  onChange={e => setSelectedSnapshot(e.target.value || null)}
                >
                  <option value="">Latest</option>
                  {snapshots.map(s => (
                    <option key={s.tag} value={s.snapshotId}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn small secondary"
                  style={{ fontSize: 11, padding: '4px 6px', flexShrink: 0 }}
                  onClick={reloadMeta}
                  title="Reload variables and snapshots (run after seeding new data)"
                >
                  ↺
                </button>
              </div>
              <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-secondary)' }}>
                {selectedSnapshot
                  ? snapshots.find(s => s.snapshotId === selectedSnapshot)?.tag ?? selectedSnapshot.slice(0, 16)
                  : meta.latest_snapshot.slice(0, 16)}
              </div>
            </>
          ) : (
            <>
              <div className="snapshot-badge">
                {meta.latest_snapshot.slice(0, 16)}
              </div>
              {meta.tags.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {meta.tags.map(t => (
                    <span key={t} className="badge blue" style={{ fontSize: 10 }}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Bounding box controls ──────────────────────────────── */}
      <div className="map-overlay bottom-left" style={{ width: 380 }}>
        <div className="overlay-title">Bounding Box</div>
        <div className="bbox-grid">
          <div className="bbox-input-wrap">
            <span className="bbox-label">Lat Min</span>
            <input
              className="bbox-input"
              type="number" step="0.5"
              value={bbox.latMin}
              onChange={e => setBbox(b => ({ ...b, latMin: Number(e.target.value) }))}
            />
          </div>
          <div className="bbox-input-wrap">
            <span className="bbox-label">Lat Max</span>
            <input
              className="bbox-input"
              type="number" step="0.5"
              value={bbox.latMax}
              onChange={e => setBbox(b => ({ ...b, latMax: Number(e.target.value) }))}
            />
          </div>
          <div className="bbox-input-wrap">
            <span className="bbox-label">Lon Min</span>
            <input
              className="bbox-input"
              type="number" step="0.5"
              value={bbox.lonMin}
              onChange={e => setBbox(b => ({ ...b, lonMin: Number(e.target.value) }))}
            />
          </div>
          <div className="bbox-input-wrap">
            <span className="bbox-label">Lon Max</span>
            <input
              className="bbox-input"
              type="number" step="0.5"
              value={bbox.lonMax}
              onChange={e => setBbox(b => ({ ...b, lonMax: Number(e.target.value) }))}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <select
            className="form-select"
            style={{ flex: 1, fontSize: 12 }}
            value=""
            onChange={e => {
              const preset = BBOX_PRESETS.find(p => p.label === e.target.value)
              if (preset) setBboxPreset(preset.bbox)
            }}
          >
            <option value="" disabled>Quick select region…</option>
            {presetGroups.map(group => (
              <optgroup key={group} label={group}>
                {BBOX_PRESETS.filter(p => p.group === group).map(p => (
                  <option key={p.label} value={p.label}>{p.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button className="btn secondary small" onClick={useViewportAsBbox} style={{ whiteSpace: 'nowrap' }}>
            Use Viewport
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="btn primary small" onClick={fetchData} disabled={loading}>
            {loading ? 'Loading…' : '↺ Refresh'}
          </button>
          <span style={{
            fontSize: 11, color: cellCount > 400_000 ? 'var(--yellow)' : 'var(--text-secondary)',
          }}>
            ~{cellCount.toLocaleString()} cells
            {cellCount > 400_000 ? ' (may be slow)' : ''}
          </span>
          {onMapContext && (
            <button
              className="btn secondary small"
              style={{ marginLeft: 'auto', fontSize: 11 }}
              title="Ask the Weather Agent about this region"
              onClick={() => {
                const regionDesc = `bounding box lat ${bbox.latMin}°–${bbox.latMax}°N, lon ${bbox.lonMin}°–${bbox.lonMax}°E`
                const msg = `What is the weather like in the region: ${regionDesc}?\n` +
                            `Please summarise temperature, wind, pressure and cloud cover.`
                onMapContext(msg)
              }}
            >
              Ask Agent ✦
            </button>
          )}
        </div>

        {/* ── Save to Snowflake table ─────────────────────────── */}
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div className="overlay-title">Save to Snowflake Table</div>

          {/* Table name input */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input
              ref={tableInputRef}
              className="bbox-input"
              type="text"
              value={tableName}
              onChange={e => setTableName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              placeholder="TABLE_NAME"
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }}
            />
          </div>

          {/* Schema label + variable count */}
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 8 }}>
            ICECHUNK_DB.ICECHUNK &nbsp;·&nbsp;
            {variableKeys.filter(v => !v.startsWith('cloud_amount_on_height')).length} variables
            {cellCount < MAX_CELLS && data.length > 0
              ? ` · ~${(data.length * variableKeys.filter(v => !v.startsWith('cloud_amount_on_height')).length).toLocaleString()} rows est.`
              : ''}
          </div>

          {/* Format toggle: Long vs Wide */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            <button
              className={`btn small ${!pivoted ? 'primary' : 'secondary'}`}
              style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
              onClick={() => setPivoted(false)}
              title="Long format — one row per (variable, lat, lon). Best for filtering by variable."
            >
              Long
            </button>
            <button
              className={`btn small ${pivoted ? 'primary' : 'secondary'}`}
              style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
              onClick={() => setPivoted(true)}
              title="Wide format — one row per (lat, lon), one column per variable. Best for analysis."
            >
              Wide (pivot)
            </button>
          </div>

          {/* Format description */}
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {pivoted
              ? 'Columns: lat, lon, h3_cell, air_temperature, wind_speed_at_10m, …'
              : 'Columns: variable, lat, lon, h3_cell, value'}
          </div>

          {/* Save button */}
          <button
            className="btn primary small"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={handleSaveTable}
            disabled={saving || !tableName.trim() || cellCount > MAX_CELLS}
          >
            {saving ? 'Saving…' : '↓ Save to Table'}
          </button>

          {/* Success */}
          {saveResult && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--green)', marginBottom: 4 }}>
                ✓ {saveResult.row_count.toLocaleString()} rows saved
              </div>
              <div style={{
                fontSize: 10, fontFamily: 'monospace',
                color: 'var(--text-secondary)',
                wordBreak: 'break-all', marginBottom: 6,
              }}>
                {saveResult.table}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  className="btn secondary small"
                  style={{ fontSize: 10, padding: '2px 8px' }}
                  onClick={handleCopyTable}
                >
                  {copied ? '✓ Copied' : 'Copy name'}
                </button>
                <button
                  className="btn primary small"
                  style={{ fontSize: 10, padding: '2px 8px', flex: 1, justifyContent: 'center' }}
                  onClick={() => fetchTableView(saveResult.table)}
                >
                  📊 View & Analyse
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {saveError && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--red)' }}>
              ⚠ {saveError}
            </div>
          )}
        </div>
      </div>

      {/* ── Colour legend + palette selector ────────────────────── */}
      <div className="map-overlay bottom-right color-legend">
        <div className="overlay-title">
          {varMeta.label}
        </div>
        <div
          className="color-bar"
          style={{ background: buildGradient(activeColorScale) }}
        />
        <div className="color-labels">
          <span>{formatValue(minVal, activeVar)}</span>
          <span>{formatValue(maxVal, activeVar)}</span>
        </div>
        {/* Palette selector */}
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4 }}>Palette</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            {(['auto', ...Object.keys(PALETTES)] as PaletteKey[]).map(key => {
              const scale = key === 'auto' ? varMeta.colorScale : PALETTES[key as Exclude<PaletteKey, 'auto'>].scale
              const label = key === 'auto' ? 'Auto' : PALETTES[key as Exclude<PaletteKey, 'auto'>].label
              return (
                <button
                  key={key}
                  title={label}
                  onClick={() => setColorScheme(key)}
                  style={{
                    width: 32,
                    height: 14,
                    border: colorScheme === key ? '2px solid var(--accent)' : '2px solid transparent',
                    borderRadius: 3,
                    cursor: 'pointer',
                    padding: 0,
                    background: buildGradient(scale),
                  }}
                />
              )
            })}
          </div>
          {colorScheme !== 'auto' && (
            <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 3 }}>
              {PALETTES[colorScheme as Exclude<PaletteKey, 'auto'>].label}
              {' · '}
              <span
                style={{ cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => setColorScheme('auto')}
              >reset</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Table Analysis Overlay ───────────────────────────────────────── */}
      {tableViewOpen && (
        <div
          onWheel={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'absolute', inset: 0, zIndex: 200,
            background: 'rgba(13,17,23,0.96)',
            display: 'flex', flexDirection: 'column',
            fontFamily: 'Inter, sans-serif',
          }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                📊 Table Analysis
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'monospace', marginTop: 2 }}>
                {saveResult?.table}
              </div>
            </div>
            <button
              className="btn secondary small"
              style={{ fontSize: 12, padding: '4px 12px' }}
              onClick={() => setTableViewOpen(false)}
            >
              ✕ Close
            </button>
          </div>

          {/* Tab bar */}
          <div style={{
            display: 'flex', gap: 0, borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}>
            {(['preview', 'stats'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setTableViewTab(tab)}
                style={{
                  padding: '8px 20px', fontSize: 12, border: 'none', cursor: 'pointer',
                  background: tableViewTab === tab ? 'var(--surface)' : 'transparent',
                  color: tableViewTab === tab ? 'var(--accent)' : 'var(--text-secondary)',
                  borderBottom: tableViewTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
                  fontWeight: tableViewTab === tab ? 600 : 400,
                  transition: 'all 0.15s',
                }}
              >
                {tab === 'preview' ? '📋 Data Preview' : '📈 Statistics'}
              </button>
            ))}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            {tableViewLoading ? (
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center', marginTop: 40 }}>
                Loading data…
              </div>
            ) : tableViewTab === 'preview' ? (
              /* ── Data Preview tab ── */
              tablePreview.length === 0 ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>No data returned.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%', color: 'var(--text)' }}>
                    <thead>
                      <tr style={{ background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 1 }}>
                        {Object.keys(tablePreview[0]).map(col => (
                          <th key={col} style={{
                            padding: '6px 10px', textAlign: 'left',
                            border: '1px solid var(--border)',
                            fontWeight: 600, fontSize: 10,
                            color: 'var(--accent)', whiteSpace: 'nowrap',
                          }}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tablePreview.map((row, i) => (
                        <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                          {Object.values(row).map((cell, j) => (
                            <td key={j} style={{
                              padding: '4px 10px',
                              border: '1px solid var(--border)',
                              fontFamily: 'monospace', fontSize: 10,
                              whiteSpace: 'nowrap',
                            }}>
                              {cell === null ? <span style={{ color: 'var(--text-secondary)' }}>NULL</span>
                                : typeof cell === 'number' ? Number(cell).toPrecision(6)
                                : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-secondary)' }}>
                    Showing first {tablePreview.length} rows
                  </div>
                </div>
              )
            ) : (
              /* ── Statistics tab ── */
              tableStats.length === 0 ? (
                <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>No statistics available.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                  {tableStats.map((row, i) => {
                    const varKey = String(row.VARIABLE ?? row.variable ?? '')
                    const vm = resolveVariableMeta(varKey)
                    const n    = Number(row.N    ?? row.n    ?? 0)
                    const minV = Number(row.MIN_VAL ?? row.min_val ?? 0)
                    const maxV = Number(row.MAX_VAL ?? row.max_val ?? 0)
                    const avgV = Number(row.AVG_VAL ?? row.avg_val ?? 0)
                    const stdV = Number(row.STD_VAL ?? row.std_val ?? 0)
                    const fmt = (v: number) => {
                      const transformed = vm.transform(v)
                      return `${transformed.toFixed(2)} ${vm.unit}`
                    }
                    return (
                      <div key={i} style={{
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        borderRadius: 6, padding: 12,
                      }}>
                        <div style={{
                          fontSize: 11, fontWeight: 600, color: 'var(--accent)',
                          marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 6,
                        }}>
                          {vm.label}
                          <span style={{ fontSize: 9, color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 6 }}>
                            ({varKey})
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 11 }}>
                          {[
                            ['Count', n.toLocaleString()],
                            ['Unit', vm.unit],
                            ['Min', fmt(minV)],
                            ['Max', fmt(maxV)],
                            ['Avg', fmt(avgV)],
                            ['Std Dev', fmt(stdV)],
                          ].map(([label, value]) => (
                            <div key={label as string}>
                              <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>{label}: </span>
                              <span style={{ color: 'var(--text)', fontFamily: 'monospace' }}>{value}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            )}
          </div>

          {/* Ask Agent footer — injected via onMapContext */}
          {!tableViewLoading && saveResult && onMapContext && (
            <div style={{
              padding: '12px 16px', borderTop: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', flex: 1 }}>
                Ask the AI agent to analyse this dataset for patterns, anomalies, or comparisons.
              </div>
              <button
                className="btn primary"
                style={{ fontSize: 12, padding: '6px 14px', flexShrink: 0 }}
                onClick={() => {
                  const statsLines = tableStats.map(row => {
                    const varKey = String(row.VARIABLE ?? row.variable ?? '')
                    const vm = resolveVariableMeta(varKey)
                    const minV = Number(row.MIN_VAL ?? row.min_val ?? 0)
                    const maxV = Number(row.MAX_VAL ?? row.max_val ?? 0)
                    const avgV = Number(row.AVG_VAL ?? row.avg_val ?? 0)
                    return `• ${vm.label}: min ${vm.transform(minV).toFixed(2)}${vm.unit}, max ${vm.transform(maxV).toFixed(2)}${vm.unit}, avg ${vm.transform(avgV).toFixed(2)}${vm.unit}`
                  }).join('\n')
                  const msg = `I've saved weather data to the Snowflake table ${saveResult.table}.
It contains ${saveResult.row_count.toLocaleString()} rows covering lat ${bbox.latMin}–${bbox.latMax}, lon ${bbox.lonMin}–${bbox.lonMax}.
Statistics:\n${statsLines}
What patterns, anomalies, or insights can you identify in this data?`
                  onMapContext(msg)
                  setTableViewOpen(false)
                }}
              >
                ✦ Ask Agent
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
