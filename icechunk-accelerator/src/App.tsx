import React, { useState } from 'react'
import { Home as HomeIcon, Map, Download, Snowflake, MessageSquare } from 'lucide-react'
import Home from './components/Home'
import WeatherViewer from './components/WeatherViewer'
import DataLoader from './components/DataLoader'
import AgentChat from './components/AgentChat'

type Tab = 'home' | 'weather-viewer' | 'data-loader'

const NAV: { key: Tab; label: string; Icon: React.ElementType }[] = [
  { key: 'home',           label: 'Overview',       Icon: HomeIcon },
  { key: 'weather-viewer', label: 'Weather Viewer',  Icon: Map },
  { key: 'data-loader',    label: 'Data Loader',     Icon: Download },
]

const FULL_WIDTH: Tab[] = ['weather-viewer']

export default function App() {
  const [active, setActive]           = useState<Tab>('home')
  const [agentOpen, setAgentOpen]     = useState(false)
  // Context message lifted from WeatherViewer map interactions
  const [agentContext, setAgentContext] = useState<string | null>(null)
  // Bbox emitted by agent tool results → zooms the map
  const [agentFocusBbox, setAgentFocusBbox] = useState<{ lat_min: number; lat_max: number; lon_min: number; lon_max: number } | null>(null)

  const isFullWidth = FULL_WIDTH.includes(active)
  const showAgent   = active === 'weather-viewer'   // agent only shown on map tab

  const handleMapContext = (msg: string) => {
    setAgentContext(msg)
    setAgentOpen(true)
  }

  return (
    <div className="app">
      {/* ── Sidebar ──────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img src="/icechunk_logo.svg" alt="IceChunk" />
          <div>
            <span>IceChunk</span>
            <small>Accelerator</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-section">Navigation</div>
          {NAV.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`sidebar-link ${active === key ? 'active' : ''}`}
              onClick={() => setActive(key)}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}

          {/* Agent toggle — only visible on Weather Viewer tab */}
          {showAgent && (
            <button
              className={`sidebar-link ${agentOpen ? 'active' : ''}`}
              onClick={() => setAgentOpen(o => !o)}
              title="Toggle weather agent chat panel"
            >
              <MessageSquare size={15} />
              Weather Agent
              <span style={{
                marginLeft: 'auto',
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 10,
                background: agentOpen ? 'var(--accent)' : 'var(--surface-2)',
                color: agentOpen ? '#fff' : 'var(--text-secondary)',
              }}>
                {agentOpen ? 'ON' : 'OFF'}
              </span>
            </button>
          )}

          <div className="sidebar-section" style={{ marginTop: 12 }}>Resources</div>
          <a
            className="sidebar-link"
            href="https://icechunk.io/en/stable/"
            target="_blank"
            rel="noreferrer"
          >
            <Snowflake size={15} />
            Icechunk Docs
          </a>
          <a
            className="sidebar-link"
            href="https://registry.opendata.aws/met-office-global-deterministic/"
            target="_blank"
            rel="noreferrer"
          >
            <Map size={15} />
            Met Office ASDI
          </a>
        </nav>

        <div className="sidebar-footer">
          <div style={{ marginBottom: 4, fontSize: 11 }}>
            <span className="status-dot green" style={{ marginRight: 5 }} />
            ICECHUNK_DB.ICECHUNK
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 10 }}>
            internal-marketplace
          </div>
        </div>
      </aside>

      {/* ── Main area ─────────────────────────────────────────────── */}
      <div className="app-content" style={{ display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>
        {/* Content column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {/* Header */}
          <header className="app-header">
            <h1>
              {NAV.find(n => n.key === active)?.label ?? 'IceChunk Accelerator'}
            </h1>
            <div className="app-header-actions">
              <span className="badge blue" style={{ fontSize: 11 }}>
                Met Office Weather
              </span>
              {showAgent && (
                <button
                  className={`btn small ${agentOpen ? 'primary' : 'secondary'}`}
                  onClick={() => setAgentOpen(o => !o)}
                  style={{ fontSize: 11, gap: 4 }}
                >
                  <MessageSquare size={13} />
                  {agentOpen ? 'Hide Agent' : 'Ask Agent'}
                </button>
              )}
            </div>
          </header>

          {/* Page content */}
          <div className={`app-main ${isFullWidth ? 'full-width' : ''}`} style={{ flex: 1, overflow: 'hidden' }}>
            {active === 'home' && (
              <Home onNavigate={tab => setActive(tab as Tab)} />
            )}
            {active === 'weather-viewer' && (
            <WeatherViewer onMapContext={handleMapContext} focusBbox={agentFocusBbox} onFocusConsumed={() => setAgentFocusBbox(null)} />
            )}
            {active === 'data-loader' && <DataLoader />}
          </div>
        </div>

        {/* Agent chat sidebar — only shown on weather viewer when toggled */}
        {showAgent && agentOpen && (
          <div style={{
            width: 340,
            minWidth: 300,
            maxWidth: 400,
            borderLeft: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            flexShrink: 0,
          }}>
            <AgentChat
              contextMessage={agentContext}
              onContextConsumed={() => setAgentContext(null)}
              onMapFocus={bbox => setAgentFocusBbox(bbox)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
