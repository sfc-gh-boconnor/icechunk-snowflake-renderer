import React, { useState } from 'react'
import { Cloud, Download, CheckCircle, AlertCircle, Loader } from 'lucide-react'
import { triggerIngest, sfQuery } from '../shared/helpers'
import { INGEST_FILES, UK_INGEST_FILES, UK_INGEST_DEFAULTS, UkIngestDim, MetaResult } from '../types'
import { formatRunStamp } from '../shared/format'

type Status = 'idle' | 'loading' | 'done' | 'error'

type SeedResult = {
  snapshot_id?: string
  variables?: string[]
  grid?: { nrows?: number; ncols?: number; lat_count?: number; lon_count?: number }
  error?: string
  tag_conflict?: boolean
  message?: string
}

const TIME_SLOTS = ['0000Z', '0600Z', '1200Z', '1800Z']

// ─── Helpers ──────────────────────────────────────────────────────────────────

function yesterdayStamp(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DataLoader() {
  const [runDate, setRunDate] = useState(yesterdayStamp())
  const [runTime, setRunTime] = useState('0000Z')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(
    new Set(INGEST_FILES.filter(f => f.sizeMb < 20).map(f => f.filename))
  )
  const [status, setStatus] = useState<Status>('idle')
  const [result, setResult] = useState<SeedResult | null>(null)
  const [meta, setMeta] = useState<MetaResult | null>(null)
  const [loadingMeta, setLoadingMeta] = useState(false)

  // UK 2km state
  const [ukStatus, setUkStatus] = useState<Status>('idle')
  const [ukResult, setUkResult] = useState<SeedResult | null>(null)
  const [ukMeta, setUkMeta] = useState<MetaResult | null>(null)
  const [loadingUkMeta, setLoadingUkMeta] = useState(false)
  const [selectedUkFiles, setSelectedUkFiles] = useState<Set<string>>(new Set(UK_INGEST_DEFAULTS))

  const ukTotalMb = UK_INGEST_FILES
    .filter(f => selectedUkFiles.has(f.filename))
    .reduce((s, f) => s + f.sizeMb, 0)

  const toggleUkFile = (filename: string) => {
    setSelectedUkFiles(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }
  const selectUkAll     = () => setSelectedUkFiles(new Set(UK_INGEST_FILES.map(f => f.filename)))
  const selectUkNone    = () => setSelectedUkFiles(new Set())
  const selectUkSurface = () => setSelectedUkFiles(new Set(UK_INGEST_DEFAULTS))

  const runStamp = `${runDate}T${runTime}`
  const totalMb = INGEST_FILES
    .filter(f => selectedFiles.has(f.filename))
    .reduce((s, f) => s + f.sizeMb, 0)

  const toggleFile = (filename: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

  const selectAll = () => setSelectedFiles(new Set(INGEST_FILES.map(f => f.filename)))
  const selectNone = () => setSelectedFiles(new Set())
  const selectSurface = () =>
    setSelectedFiles(new Set(INGEST_FILES.filter(f => f.sizeMb < 20).map(f => f.filename)))

  const loadRepo = async () => {
    setLoadingMeta(true)
    const rows = await sfQuery(
      'SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_META() AS result',
      'ICECHUNK_DB',
      'ICECHUNK'
    )
    if (rows.length > 0) {
      const raw = rows[0].RESULT ?? rows[0].result
      setMeta(typeof raw === 'string' ? JSON.parse(raw) : raw as MetaResult)
    }
    setLoadingMeta(false)
  }

  const loadUkRepo = async () => {
    setLoadingUkMeta(true)
    try {
      const rows = await sfQuery(
        'SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_META_UK() AS result',
        'ICECHUNK_DB',
        'ICECHUNK'
      )
      if (rows.length > 0) {
        const raw = rows[0].RESULT ?? rows[0].result
        setUkMeta(typeof raw === 'string' ? JSON.parse(raw) : raw as MetaResult)
      }
    } catch {
      setUkMeta(null)
    }
    setLoadingUkMeta(false)
  }

  const handleLoad = async () => {
    if (selectedFiles.size === 0) return
    setStatus('loading')
    setResult(null)
    const res = await triggerIngest(runStamp, Array.from(selectedFiles))
    if (res.status === 'error') {
      setStatus('error')
      setResult({ error: res.error })
    } else {
      setStatus('done')
      setResult(res)
      await loadRepo() // refresh meta
    }
  }

  const handleLoadUk = async () => {
    setUkStatus('loading')
    setUkResult(null)
    try {
      const resp = await fetch('/api/ingest_uk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedFiles: Array.from(selectedUkFiles) }),
      })
      const json = await resp.json() as SeedResult & { error?: string }
      if (!resp.ok || json.error) {
        setUkStatus('error')
        setUkResult({ error: json.error ?? 'Unknown error' })
      } else {
        setUkStatus('done')
        setUkResult(json)
        await loadUkRepo()
      }
    } catch (e) {
      setUkStatus('error')
      setUkResult({ error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ── Date input helpers ─────────────────────────────────────────────────────
  const dateInputValue = runDate.length === 8
    ? `${runDate.slice(0, 4)}-${runDate.slice(4, 6)}-${runDate.slice(6, 8)}`
    : runDate
  const onDateChange = (v: string) => setRunDate(v.replace(/-/g, ''))

  // ─── Tab state ────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<'global' | 'uk'>('global')

  return (
    <div className="app-main scrollable">
      <div style={{ maxWidth: 680 }}>

        {/* ── Header + tab switcher ────────────────────────────────── */}
        <div style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>
            Met Office Data Loader
          </h2>
          <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', paddingBottom: 0 }}>
            {([
              { id: 'global', label: '🌍 Global 10km' },
              { id: 'uk',     label: '🇬🇧 UK 2km' },
            ] as const).map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  padding: '7px 18px',
                  fontSize: 13,
                  fontWeight: tab === t.id ? 600 : 400,
                  color: tab === t.id ? 'var(--accent)' : 'var(--text-secondary)',
                  background: 'none',
                  border: 'none',
                  borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
                  cursor: 'pointer',
                  marginBottom: -1,
                  transition: 'color 0.15s, border-color 0.15s',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ═══════════════════════ GLOBAL TAB ═══════════════════════════ */}
        {tab === 'global' && (<>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
            Download NetCDF files from the Met Office Global Deterministic 10km model
            (public ASDI S3 bucket) and store them as Icechunk Zarr arrays in{' '}
            <code style={{ background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3, fontSize: 12 }}>
              s3://icechunk-ro/met_office_global/
            </code>.
          </p>
          <div style={{
            marginBottom: 16, padding: '8px 12px',
            background: 'rgba(229,161,0,0.1)', border: '1px solid rgba(229,161,0,0.3)',
            borderRadius: 6, fontSize: 12, color: 'var(--yellow)',
          }}>
            Note: The date selector is informational only — <code>ICECHUNK_SEED()</code> loads
            the latest available Met Office run from ASDI automatically. Today&apos;s run
            is typically published 3–6 hours after the model valid time.
          </div>

          {/* ── Current repo state ───────────────────────────────────── */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-title">Repository State</div>
            {!meta ? (
              <button className="btn secondary small" onClick={loadRepo} disabled={loadingMeta}>
                {loadingMeta ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Loading…</> : '↺ Load Repo Info'}
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="grid-3">
                  <div className="metric-card">
                    <div className="metric-value" style={{ fontSize: 16 }}>{meta.variables.length}</div>
                    <div className="metric-label">Variables</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-value" style={{ fontSize: 16 }}>
                      {((meta.grid.lat_count ?? meta.grid.nrows ?? 0) * (meta.grid.lon_count ?? meta.grid.ncols ?? 0) / 1e6).toFixed(1)}M
                    </div>
                    <div className="metric-label">Grid Points</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-value" style={{ fontSize: 14 }}>
                      {meta.latest_snapshot.slice(0, 12)}
                    </div>
                    <div className="metric-label">Latest Snapshot</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>Tags</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {meta.tags.map(t => (
                      <span key={t} className="badge blue" style={{ fontSize: 11 }}>{t}</span>
                    ))}
                    {meta.tags.length === 0 && (
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>none</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Model run selection ────────────────────────────────────── */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-title">Model Run</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: 1, minWidth: 160 }}>
                <label className="form-label">Date</label>
                <input
                  type="date"
                  className="form-input"
                  value={dateInputValue}
                  onChange={e => onDateChange(e.target.value)}
                  max={new Date().toISOString().slice(0, 10)}
                />
              </div>
              <div className="form-group" style={{ width: 140 }}>
                <label className="form-label">Time (UTC)</label>
                <select className="form-select" value={runTime} onChange={e => setRunTime(e.target.value)}>
                  {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              Run stamp: <code style={{ color: 'var(--accent)' }}>{runStamp}</code>
              {' — '}
              <a href="https://registry.opendata.aws/met-office-global-deterministic/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                ASDI listing ↗
              </a>
            </div>
          </div>

          {/* ── Variable selection ────────────────────────────────────── */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div className="panel-title" style={{ marginBottom: 0 }}>Variables to Load</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn secondary small" onClick={selectSurface}>Surface</button>
                <button className="btn secondary small" onClick={selectAll}>All</button>
                <button className="btn secondary small" onClick={selectNone}>None</button>
              </div>
            </div>
            <div className="checkbox-list">
              {INGEST_FILES.map(f => (
                <label key={f.filename} className="checkbox-item">
                  <input type="checkbox" checked={selectedFiles.has(f.filename)} onChange={() => toggleFile(f.filename)} />
                  <span>{f.label}</span>
                  {f.sizeMb > 20 && <span className="badge dim-3d" style={{ fontSize: 10, marginLeft: 4 }}>3D</span>}
                  <span className="var-size">{f.sizeMb.toFixed(1)} MB</span>
                </label>
              ))}
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
              Selected: {selectedFiles.size} files — ~{totalMb.toFixed(0)} MB download
            </div>
          </div>

          {/* ── Load button & status ──────────────────────────────────── */}
          <div className="panel">
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <button
                className="btn primary"
                onClick={handleLoad}
                disabled={status === 'loading' || selectedFiles.size === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                {status === 'loading'
                  ? <><Loader size={15} style={{ animation: 'spin 0.7s linear infinite' }} /> Loading…</>
                  : <><Download size={15} /> Load {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''}</>}
              </button>
              {status === 'loading' && (
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Downloading from ASDI S3 and writing to Icechunk…
                </span>
              )}
            </div>
            {status === 'loading' && (
              <div className="progress-bar" style={{ marginBottom: 12 }}>
                <div className="progress-fill" style={{ width: '100%', animation: 'progIndeterminate 1.5s ease-in-out infinite' }} />
              </div>
            )}
            {status === 'done' && result && (
              <div style={{ background: 'rgba(13,176,72,0.1)', border: '1px solid rgba(13,176,72,0.3)', borderRadius: 'var(--radius)', padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <CheckCircle size={16} color="var(--green)" />
                  <span style={{ fontWeight: 600, color: 'var(--green)' }}>Load successful</span>
                </div>
                {result.snapshot_id && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Snapshot: <code style={{ color: 'var(--accent)' }}>{result.snapshot_id}</code></div>}
                {result.message && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{result.message}</div>}
              </div>
            )}
            {status === 'error' && result?.error && (
              <div style={{ background: 'rgba(229,72,77,0.1)', border: '1px solid rgba(229,72,77,0.3)', borderRadius: 'var(--radius)', padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <AlertCircle size={16} color="var(--red)" />
                  <span style={{ fontWeight: 600, color: 'var(--red)' }}>
                    {result.tag_conflict ? 'IceChunk tag conflict' : 'Load failed'}
                  </span>
                </div>
                {result.tag_conflict ? (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    <code>ICECHUNK_SEED()</code> tried to create a tag that already exists. This is harmless — the data was loaded. Re-run to update to a newer run.
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{result.error}</div>
                )}
              </div>
            )}
          </div>
        </>)}

        {/* ═══════════════════════ UK TAB ═══════════════════════════════ */}
        {tab === 'uk' && (<>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>
            Download the latest hourly run of the Met Office UK Deterministic 2km model
            from the ASDI S3 bucket, reproject from Lambert Azimuthal Equal Area to WGS84,
            and store as an IceChunk Zarr array in{' '}
            <code style={{ background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3, fontSize: 12 }}>
              s3://icechunk-ro/met_office_uk_2km/
            </code>.
          </p>

          {/* UK repo state */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-title">UK Repository State</div>
            {!ukMeta ? (
              <button className="btn secondary small" onClick={loadUkRepo} disabled={loadingUkMeta}>
                {loadingUkMeta
                  ? <><span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} /> Loading…</>
                  : '↺ Load Repo Info'}
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="grid-3">
                  <div className="metric-card">
                    <div className="metric-value" style={{ fontSize: 16 }}>{ukMeta.variables.length}</div>
                    <div className="metric-label">Variables</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-value" style={{ fontSize: 16 }}>
                      {ukMeta.grid
                        ? (((ukMeta.grid as {nrows?:number; ncols?:number}).nrows ?? 0) *
                           ((ukMeta.grid as {nrows?:number; ncols?:number}).ncols ?? 0) / 1e6).toFixed(1) + 'M'
                        : '—'}
                    </div>
                    <div className="metric-label">Grid Points</div>
                  </div>
                  <div className="metric-card">
                    <div className="metric-value" style={{ fontSize: 14 }}>
                      {ukMeta.latest_snapshot?.slice(0, 12) ?? '—'}
                    </div>
                    <div className="metric-label">Latest Snapshot</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>Tags</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(ukMeta.tags ?? []).map(t => (
                      <span key={t} className="badge blue" style={{ fontSize: 11 }}>{t}</span>
                    ))}
                    {(!ukMeta.tags || ukMeta.tags.length === 0) && (
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>none</span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* UK variable selector */}
          <div className="panel" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div className="panel-title" style={{ marginBottom: 0 }}>Variables to Load</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn secondary small" onClick={selectUkSurface}>Surface</button>
                <button className="btn secondary small" onClick={selectUkAll}>All</button>
                <button className="btn secondary small" onClick={selectUkNone}>None</button>
              </div>
            </div>
            {(['surface', 'height_levels', 'pressure_levels'] as UkIngestDim[]).map(dim => {
              const dimFiles = UK_INGEST_FILES.filter(f => f.dim === dim)
              const dimLabel: Record<UkIngestDim, string> = {
                surface:         'Surface (2D)',
                height_levels:   'Height Levels (3D)',
                pressure_levels: 'Pressure Levels (3D)',
              }
              return (
                <div key={dim} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                    {dimLabel[dim]}
                  </div>
                  <div className="checkbox-list">
                    {dimFiles.map(f => (
                      <label key={f.filename} className="checkbox-item">
                        <input type="checkbox" checked={selectedUkFiles.has(f.filename)} onChange={() => toggleUkFile(f.filename)} />
                        <span>{f.label}</span>
                        {f.dim !== 'surface' && <span className="badge dim-3d" style={{ fontSize: 10, marginLeft: 4 }}>3D</span>}
                        <span className="var-size">{f.sizeMb.toFixed(0)} MB</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
              Selected: {selectedUkFiles.size} variables — ~{ukTotalMb.toFixed(0)} MB download
            </div>
          </div>

          {/* UK seed button */}
          <div className="panel">
            <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              Loads the latest available hourly run automatically.
              {selectedUkFiles.size === 0
                ? ' No variables selected.'
                : ` ${selectedUkFiles.size} variable${selectedUkFiles.size !== 1 ? 's' : ''} selected (~${ukTotalMb.toFixed(0)} MB total download).`}
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <button
                className="btn primary"
                onClick={handleLoadUk}
                disabled={ukStatus === 'loading' || selectedUkFiles.size === 0}
                style={{ display: 'flex', alignItems: 'center', gap: 8 }}
              >
                {ukStatus === 'loading'
                  ? <><Loader size={15} style={{ animation: 'spin 0.7s linear infinite' }} /> Loading…</>
                  : <><Download size={15} /> Seed UK 2km Data ({selectedUkFiles.size})</>}
              </button>
              {ukStatus === 'loading' && (
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Downloading from ASDI S3, reprojecting and writing to IceChunk…
                </span>
              )}
            </div>
            {ukStatus === 'loading' && (
              <div className="progress-bar" style={{ marginBottom: 12 }}>
                <div className="progress-fill" style={{ width: '100%', animation: 'progIndeterminate 1.5s ease-in-out infinite' }} />
              </div>
            )}
            {ukStatus === 'done' && ukResult && (
              <div style={{ background: 'rgba(13,176,72,0.1)', border: '1px solid rgba(13,176,72,0.3)', borderRadius: 'var(--radius)', padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <CheckCircle size={16} color="var(--green)" />
                  <span style={{ fontWeight: 600, color: 'var(--green)' }}>UK seed successful</span>
                </div>
                {ukResult.snapshot_id && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Snapshot: <code style={{ color: 'var(--accent)' }}>{ukResult.snapshot_id}</code></div>}
                {ukResult.message && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{ukResult.message}</div>}
                {ukResult.variables && ukResult.variables.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {ukResult.variables.map(v => <span key={v} className="badge blue" style={{ fontSize: 11 }}>{v}</span>)}
                  </div>
                )}
              </div>
            )}
            {ukStatus === 'error' && ukResult?.error && (
              <div style={{ background: 'rgba(229,72,77,0.1)', border: '1px solid rgba(229,72,77,0.3)', borderRadius: 'var(--radius)', padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <AlertCircle size={16} color="var(--red)" />
                  <span style={{ fontWeight: 600, color: 'var(--red)' }}>UK seed failed</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{ukResult.error}</div>
              </div>
            )}
          </div>
        </>)}

        <style>{`
          @keyframes progIndeterminate {
            0%   { transform: translateX(-100%); width: 60%; }
            50%  { transform: translateX(70%);  width: 60%; }
            100% { transform: translateX(200%); width: 60%; }
          }
        `}</style>
      </div>
    </div>
  )
}
