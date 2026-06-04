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
const MAX_CELLS = 500_000
// TARGET_UK_RAW: backend auto-strides UK raw queries to stay under this count
// (keeps Snowflake external function responses within ~10MB).
const TARGET_UK_RAW = 80_000

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
  const [data, setData] = useState<WeatherPoint[]>([])
  const [meta, setMeta] = useState<MetaResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opacity, setOpacity] = useState(0.85)
  // 'h3' (default) uses ICECHUNK_SLICE_H3 — Python-aggregated, fewer rows, fastest
  // 'points' uses ICECHUNK_SLICE — raw grid points rendered as SolidPolygonLayer
  const [renderMode, setRenderMode] = useState<'h3' | 'points'>('h3')
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
  // - UK: fixed set (2km dataset has specific vars)
  // - Global: always use the full VARIABLES list from types.ts so that
  //   cloud_amount_on_height_levels (3D) is always selectable.
  //   meta.variables only reflects the *main* branch snapshot, not the
  //   cloud snapshot the user may have selected.
  const availableVars = dataset === 'uk'
    ? UK_VARIABLES.map(k => resolveVariableMeta(k))
    : VARIABLES.filter(v => v.key !== 'visibility_at_screen_level')

  const varMeta = useMemo(() => resolveVariableMeta(activeVar), [activeVar])

  // When meta loads, switch to the first available variable only if the active
  // variable is unknown to both meta AND our static VARIABLES list.
  // This avoids resetting cloud_amount_on_height_levels (which is not in the
  // main-branch meta.variables but IS a valid selectable variable).
  useEffect(() => {
    if (meta?.variables?.length
      && !meta.variables.includes(activeVar)
      && !VARIABLES.find(v => v.key === activeVar)) {
      setActiveVar(meta.variables[0])
    }
  }, [meta])

  // When dataset changes: zoom to its default bbox and validate active variable
  useEffect(() => {
    if (dataset === 'uk') {
      setBboxPreset(UK_BBOX)
      if (!UK_VARIABLES.includes(activeVar)) setActiveVar('air_temperature')
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

  // ── Fetch weather data ───────────────────────────────────────────────────────
  // h3Res is included so a zoom-level change that crosses a resolution
  // boundary will trigger a re-fetch with the correct H3 resolution baked
  // into the Snowflake query.
  const fetchData = useCallback(async () => {
    if (!varMeta) return
    if (!meta) return
    // For UK grid mode use the actual ~2km spacing to estimate cell count;
    // the global estimator uses 10km spacing and underestimates by ~25x.
    const ukGrid = dataset === 'uk' && renderMode === 'points'
    const cellCount = ukGrid
      ? Math.ceil((bbox.latMax - bbox.latMin) / 0.019) *
        Math.ceil((bbox.lonMax - bbox.lonMin) / 0.032)
      : estimateCellCount(bbox.latMin, bbox.latMax, bbox.lonMin, bbox.lonMax)
    // Backend auto-strides large UK requests, so check effective post-stride count.
    const stride = ukGrid && cellCount > TARGET_UK_RAW
      ? Math.max(1, Math.ceil(Math.sqrt(cellCount / TARGET_UK_RAW)))
      : 1
    const effectiveCells = ukGrid ? Math.ceil(cellCount / (stride * stride)) : cellCount
    const limit = ukGrid ? TARGET_UK_RAW * 2 : MAX_CELLS
    if (effectiveCells > limit) {
      setError(
        ukGrid
          ? `UK grid area too large (~${effectiveCells.toLocaleString()} effective cells). Zoom in or use H3 mode.`
          : `Selection too large (~${cellCount.toLocaleString()} cells). Narrow your bounding box.`
      )
      return
    }
    setError(null)
    setLoading(true)
    try {
      let rows: Record<string, unknown>[]
      const snapExpr = selectedSnapshot ? `'${selectedSnapshot}'` : 'NULL'

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
        // UK 2km — raw grid points (WGS84 lat/lon pre-computed at ingest)
        rows = await sfQuery(
          `SELECT f.value:lat::FLOAT AS lat,
                  f.value:lon::FLOAT AS lon,
                  f.value:value::FLOAT AS value
           FROM (SELECT ${QUERY_DB}.${QUERY_SCHEMA}.ICECHUNK_SLICE_UK(
             '${activeVar}', ${bbox.latMin}, ${bbox.latMax}, ${bbox.lonMin}, ${bbox.lonMax}, ${snapExpr}
           ) AS result) r, LATERAL FLATTEN(input => r.result:data) f`,
          QUERY_DB,
          QUERY_SCHEMA
        )
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

      const points: WeatherPoint[] = rows.map(r => {
        // For 3D H3 cloud: value column is raw fraction (0-1); transform ×100 → pct
        // For 3D scatter cloud: cloud_pct column is already 0-100; transform ×100 → 0-10000
        //   (auto-ranging handles the display correctly)
        // For all 2D variables: value column, apply transform
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

      if (points.length > 0) {
        let computedMin = points[0].value
        let computedMax = points[0].value
        for (const p of points) {
          if (p.value < computedMin) computedMin = p.value
          if (p.value > computedMax) computedMax = p.value
        }
        setMinVal(computedMin)
        setMaxVal(computedMax)
        if (points[0].height_m != null) setHeightM(points[0].height_m)
        const tl = Number((rows[0] as Record<string, unknown>).TOTAL_LEVELS ?? (rows[0] as Record<string, unknown>).total_levels)
        if (tl > 0) setTotalLevels(tl)
      }
      setData(points)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [activeVar, bbox, heightLevel, varMeta, selectedSnapshot, meta, h3Res, renderMode, dataset])

  useEffect(() => { fetchData() }, [fetchData])

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
  // Global 10km: ~0.09° spacing → half-extents 0.045° × 0.045°
  // UK 2km:  lat range 18.85° / 970 rows ≈ 0.019°, lon range 33.73° / 1042 cols ≈ 0.032°
  //
  // Auto-stride: backend subsamples the UK grid by stride = ceil(sqrt(n/TARGET_UK_RAW))
  // when the bbox would return more than TARGET_UK_RAW raw cells. We compute the same
  // stride here so the SolidPolygonLayer cells are scaled to fill the gaps.
  const ukEstimate = dataset === 'uk' && renderMode === 'points'
    ? Math.ceil((bbox.latMax - bbox.latMin) / 0.019) *
      Math.ceil((bbox.lonMax - bbox.lonMin) / 0.032)
    : 0
  const ukStride = ukEstimate > TARGET_UK_RAW
    ? Math.max(1, Math.ceil(Math.sqrt(ukEstimate / TARGET_UK_RAW)))
    : 1

  // Multiply by 1.008 to add ~0.8% overlap so the dark basemap doesn't bleed
  // through the hairline gaps between adjacent cells.
  const halfDegLat = (dataset === 'uk' ? 0.0097 * ukStride : 0.045) * 1.008
  const halfDegLon = (dataset === 'uk' ? 0.0162 * ukStride : 0.045) * 1.008

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
        getFillColor: d => valueToRgba(d.value, minVal, maxVal, varMeta.colorScale),
        getLineColor: [0, 0, 0, 0],
        filled: true,
        extruded: false,
        pickable: true,
        onClick: handleLayerClick,
        opacity,
        updateTriggers: {
          getFillColor: [minVal, maxVal, activeVar, heightLevel],
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
        getFillColor: d => valueToRgba(d.value, minVal, maxVal, varMeta.colorScale),
        getLineColor: [0, 0, 0, 0],
        pickable: true,
        onClick: handleLayerClick,
        opacity,
        updateTriggers: {
          getFillColor: [minVal, maxVal, activeVar, heightLevel],
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
        getFillColor: d => valueToRgba(d.value, minVal, maxVal, varMeta.colorScale),
        getLineColor: [0, 0, 0, 0],
        pickable: true,
        onClick: handleLayerClick,
        opacity,
        updateTriggers: {
          getFillColor: [minVal, maxVal, activeVar, heightLevel],
          getPolygon:   [dataset],
        },
      })
    : new H3HexagonLayer<WeatherPoint>({
        id: 'weather-h3',
        data,
        // h3index is pre-computed by the Python backend in ICECHUNK_SLICE_H3
        // — no client-side h3-js needed, no SQL H3 functions per row
        getHexagon: d => d.h3index ?? '',
        getFillColor: d => valueToRgba(d.value, minVal, maxVal, varMeta.colorScale),
        getLineColor: [0, 0, 0, 0],
        filled: true,
        extruded: false,
        pickable: true,
        onClick: handleLayerClick,
        opacity,
        updateTriggers: {
          getFillColor: [minVal, maxVal, activeVar, heightLevel],
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
    ? Math.ceil((bbox.latMax - bbox.latMin) / 0.019) *
      Math.ceil((bbox.lonMax - bbox.lonMin) / 0.032)
    : 0
  const displayStride = ukRawEstimate > TARGET_UK_RAW
    ? Math.max(1, Math.ceil(Math.sqrt(ukRawEstimate / TARGET_UK_RAW)))
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
      const body = await res.json() as { table?: string; row_count?: number; error?: string }
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
            onChange={e => setActiveVar(e.target.value)}
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
          </div>
        )}

        {/* Render mode toggle — H3 hexagons vs raw dots/grid */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
          <button
            className={`btn small ${renderMode === 'h3' ? 'primary' : 'secondary'}`}
            style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
            onClick={() => setRenderMode('h3')}
            title="H3 hexagons — Python aggregation, faster"
          >
            ⬡ H3
          </button>
          <button
            className={`btn small ${renderMode === 'points' ? 'primary' : 'secondary'}`}
            style={{ flex: 1, justifyContent: 'center', fontSize: 11 }}
            onClick={() => setRenderMode('points')}
            title={`Native grid cells (${dataset === 'uk' ? '~2km squares' : '~10km squares'})`}
          >
            ▦ Grid
          </button>
        </div>

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
              <select
                className="form-select"
                style={{ fontSize: 12, padding: '4px 8px' }}
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
                wordBreak: 'break-all', marginBottom: 4,
              }}>
                {saveResult.table}
              </div>
              <button
                className="btn secondary small"
                style={{ fontSize: 10, padding: '2px 8px' }}
                onClick={handleCopyTable}
              >
                {copied ? '✓ Copied' : 'Copy name'}
              </button>
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

      {/* ── Colour legend ──────────────────────────────────────── */}
      <div className="map-overlay bottom-right color-legend">
        <div className="overlay-title">
          {varMeta.label}
        </div>
        <div
          className="color-bar"
          style={{ background: buildGradient(varMeta.colorScale) }}
        />
        <div className="color-labels">
          <span>{formatValue(minVal, activeVar)}</span>
          <span>{formatValue(maxVal, activeVar)}</span>
        </div>
      </div>
    </div>
  )
}
