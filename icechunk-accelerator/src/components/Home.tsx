import React, { useEffect, useState } from 'react'
import { Database, Grid3x3, Tag, Clock, Layers, Info } from 'lucide-react'
import { sfQuery } from '../shared/helpers'
import { MetaResult, VARIABLES } from '../types'

export default function Home({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [meta, setMeta] = useState<MetaResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      const rows = await sfQuery(
        'SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_META() AS result',
        'ICECHUNK_DB',
        'ICECHUNK'
      )
      if (rows.length > 0) {
        const raw = rows[0].RESULT ?? rows[0].result
        setMeta(typeof raw === 'string' ? JSON.parse(raw) : raw as MetaResult)
      }
      setLoading(false)
    }
    load()
  }, [])

  return (
    <div className="app-main scrollable">
      {/* ── Hero ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
          <img src="/icechunk_logo.svg" style={{ width: 44, height: 44 }} alt="IceChunk" />
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2 }}>
              IceChunk Accelerator
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 2 }}>
              Transactional tensor storage — Met Office Global Deterministic 10km
            </p>
          </div>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7, maxWidth: 640 }}>
          Explore real-time weather forecast data stored in{' '}
          <a href="https://icechunk.io" target="_blank" rel="noreferrer"
             style={{ color: 'var(--accent)' }}>Icechunk</a>{' '}
          (Zarr transactional format) on S3. Query, slice, and visualise multi-dimensional
          arrays directly from Snowflake using SPCS service functions.
        </p>
      </div>

      {/* ── Repo stats ────────────────────────────────────────────── */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-title">Repository Status</div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)' }}>
            <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
            Connecting to ICECHUNK_DB.ICECHUNK…
          </div>
        ) : meta ? (
          <div>
            <div className="grid-3" style={{ marginBottom: 14 }}>
              <div className="metric-card">
                <div className="metric-value">{meta.variables.length}</div>
                <div className="metric-label">Variables</div>
              </div>
              <div className="metric-card">
                <div className="metric-value">
                  {(meta.grid.lat_count * meta.grid.lon_count / 1e6).toFixed(1)}M
                </div>
                <div className="metric-label">Grid Points</div>
              </div>
              <div className="metric-card">
                <div className="metric-value" style={{ fontSize: 14 }}>
                  {meta.grid.lat_count} × {meta.grid.lon_count}
                </div>
                <div className="metric-label">lat × lon (~0.09°)</div>
              </div>
            </div>

            {/* snapshot */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
              <Database size={14} color="var(--text-secondary)" />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Latest snapshot:
              </span>
              <code style={{ fontSize: 12, color: 'var(--accent)' }}>
                {meta.latest_snapshot}
              </code>
            </div>

            {/* branches */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
              <Layers size={14} color="var(--text-secondary)" />
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Branches:
              </span>
              {meta.branches.map(b => (
                <span key={b} className="badge gray">{b}</span>
              ))}
            </div>

            {/* tags */}
            {meta.tags.length > 0 && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <Tag size={14} color="var(--text-secondary)" style={{ marginTop: 2 }} />
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {meta.tags.map(t => (
                    <span key={t} className="badge blue" style={{ fontSize: 11 }}>{t}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
            Could not connect to Snowflake. Check the ICECHUNK_SERVICE is running.
          </div>
        )}
      </div>

      {/* ── Variables grid ────────────────────────────────────────── */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-title">Available Variables</div>
        <div className="var-pills">
          {VARIABLES.map(v => {
            const inRepo = meta?.variables?.includes(v.key) ?? true
            return (
              <span
                key={v.key}
                className={`var-pill ${v.is3D ? 'is3d' : ''}`}
                style={{ opacity: inRepo ? 1 : 0.4 }}
                title={`${v.label} (${v.unit})${v.is3D ? ' — 3D: 33 height levels' : ''}`}
              >
                {v.is3D && <span style={{ fontSize: 9 }}>3D</span>}
                {v.label}
                <span style={{ fontSize: 10, color: 'inherit', opacity: 0.7 }}>
                  {v.unit}
                </span>
              </span>
            )
          })}
        </div>
      </div>

      {/* ── Quick action cards ────────────────────────────────────── */}
      <div className="grid-2">
        <div
          className="panel"
          style={{ cursor: 'pointer', borderColor: 'var(--accent)', transition: 'border-color 0.2s' }}
          onClick={() => onNavigate('weather-viewer')}
        >
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'var(--accent-dim)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Grid3x3 size={20} color="var(--accent)" />
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Weather Viewer</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Interactive deck.gl map — slice 2D and 3D variables by region
              </div>
            </div>
          </div>
        </div>

        <div
          className="panel"
          style={{ cursor: 'pointer', transition: 'border-color 0.2s' }}
          onClick={() => onNavigate('data-loader')}
        >
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'rgba(13,176,72,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Clock size={20} color="var(--green)" />
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Data Loader</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Download Met Office NetCDF forecasts and store as Zarr in Icechunk
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Architecture note ─────────────────────────────────────── */}
      <div className="panel" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Info size={14} color="var(--text-secondary)" style={{ marginTop: 2 }} />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <strong style={{ color: 'var(--text)' }}>Architecture:</strong>{' '}
            Zarr chunks stored at <code>s3://icechunk-ro/met_office_global/</code> via{' '}
            <code>ICECHUNK_SERVICE</code> SPCS container. Queries run through Snowflake
            service functions <code>ICECHUNK_SLICE()</code> and{' '}
            <code>ICECHUNK_CLOUD_AT_LEVEL()</code> on <code>ICECHUNK_DB.ICECHUNK</code>.
          </div>
        </div>
      </div>
    </div>
  )
}
