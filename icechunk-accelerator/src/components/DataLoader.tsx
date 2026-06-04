import React, { useState } from 'react'
import { Cloud, Download, CheckCircle, AlertCircle, Loader } from 'lucide-react'
import { triggerIngest, sfQuery } from '../shared/helpers'
import { INGEST_FILES, MetaResult } from '../types'
import { formatRunStamp } from '../shared/format'

type Status = 'idle' | 'loading' | 'done' | 'error'

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
  const [result, setResult] = useState<{
    snapshot_id?: string
    variables?: string[]
    error?: string
    tag_conflict?: boolean
    message?: string
  } | null>(null)
  const [meta, setMeta] = useState<MetaResult | null>(null)
  const [loadingMeta, setLoadingMeta] = useState(false)

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

  // ── Date input helpers ─────────────────────────────────────────────────────
  const dateInputValue = runDate.length === 8
    ? `${runDate.slice(0, 4)}-${runDate.slice(4, 6)}-${runDate.slice(6, 8)}`
    : runDate
  const onDateChange = (v: string) => setRunDate(v.replace(/-/g, ''))

  return (
    <div className="app-main scrollable">
      <div style={{ maxWidth: 680 }}>

        {/* ── Header ──────────────────────────────────────────────── */}
        <div style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
            Met Office Data Loader
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
            Download NetCDF files from the Met Office Global Deterministic 10km model
            (public ASDI S3 bucket) and store them as Icechunk Zarr arrays in
            <code style={{ background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 3, fontSize: 12 }}>
              {' '}s3://icechunk-ro/met_office_global/{' '}
            </code>.
          </p>
          <div style={{
            marginTop: 8, padding: '8px 12px',
            background: 'rgba(229,161,0,0.1)', border: '1px solid rgba(229,161,0,0.3)',
            borderRadius: 6, fontSize: 12, color: 'var(--yellow)',
          }}>
            Note: The date selector is informational only — <code>ICECHUNK_SEED()</code> loads
            the latest available Met Office run from ASDI automatically. Today&apos;s run
            is typically published 3–6 hours after the model valid time.
          </div>
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
                  <div className="metric-value" style={{ fontSize: 16 }}>
                    {meta.variables.length}
                  </div>
                  <div className="metric-label">Variables</div>
                </div>
                <div className="metric-card">
                  <div className="metric-value" style={{ fontSize: 16 }}>
                    {(meta.grid.lat_count * meta.grid.lon_count / 1e6).toFixed(1)}M
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
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  Tags
                </div>
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
              <select
                className="form-select"
                value={runTime}
                onChange={e => setRunTime(e.target.value)}
              >
                {TIME_SLOTS.map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
            Run stamp: <code style={{ color: 'var(--accent)' }}>{runStamp}</code>
            {' — '}
            <a
              href={`https://registry.opendata.aws/met-office-global-deterministic/`}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)' }}
            >
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
                <input
                  type="checkbox"
                  checked={selectedFiles.has(f.filename)}
                  onChange={() => toggleFile(f.filename)}
                />
                <span>{f.label}</span>
                {f.sizeMb > 20 && (
                  <span className="badge dim-3d" style={{ fontSize: 10, marginLeft: 4 }}>3D</span>
                )}
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
              {status === 'loading' ? (
                <><Loader size={15} style={{ animation: 'spin 0.7s linear infinite' }} /> Loading…</>
              ) : (
                <><Download size={15} /> Load {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''}</>
              )}
            </button>
            {status === 'loading' && (
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Downloading from ASDI S3 and writing to Icechunk…
              </span>
            )}
          </div>

          {status === 'loading' && (
            <div className="progress-bar" style={{ marginBottom: 12 }}>
              <div
                className="progress-fill"
                style={{ width: '100%', animation: 'progIndeterminate 1.5s ease-in-out infinite' }}
              />
            </div>
          )}

          {status === 'done' && result && (
            <div style={{
              background: 'rgba(13,176,72,0.1)', border: '1px solid rgba(13,176,72,0.3)',
              borderRadius: 'var(--radius)', padding: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <CheckCircle size={16} color="var(--green)" />
                <span style={{ fontWeight: 600, color: 'var(--green)' }}>Load successful</span>
              </div>
              {result.snapshot_id && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  Snapshot: <code style={{ color: 'var(--accent)' }}>{result.snapshot_id}</code>
                </div>
              )}
              {result.message && (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                  {result.message}
                </div>
              )}
            </div>
          )}

          {status === 'error' && result?.error && (
            <div style={{
              background: 'rgba(229,72,77,0.1)', border: '1px solid rgba(229,72,77,0.3)',
              borderRadius: 'var(--radius)', padding: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <AlertCircle size={16} color="var(--red)" />
                <span style={{ fontWeight: 600, color: 'var(--red)' }}>
                  {result.tag_conflict ? 'IceChunk tag conflict' : 'Load failed'}
                </span>
              </div>
              {result.tag_conflict ? (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  <code>ICECHUNK_SEED()</code> tries to create an immutable <code>v1.0</code> tag
                  on every call, but it already exists from the initial load.
                  This is a bug in the Python service — it needs to skip tag creation
                  when the tag already exists. Contact the service owner to fix <code>ICECHUNK_SEED()</code>.
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{result.error}</div>
              )}
            </div>
          )}
        </div>

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
