import React, { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// ─────────────────────────────────────────────────────────────────────────────
// Types

type StreamBlock =
  | { type: 'tool_use';    name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: unknown }
  | { type: 'status';      label: string }

interface Message {
  role: 'user' | 'assistant'
  content: string           // plain text (used for history sent to API)
  blocks?: StreamBlock[]    // rich display blocks (thinking, tools)
  isStreaming?: boolean
}

interface AgentChatProps {
  /** Pre-filled message from map interaction (click or bbox selection). */
  contextMessage?: string | null
  onContextConsumed?: () => void
  /** Called when the agent returns a bounding box to focus the map on. */
  onMapFocus?: (bbox: { lat_min: number; lat_max: number; lon_min: number; lon_max: number }) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Collapsible block components

function ToolUseBlock({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false)
  const label = name.replace(/^tool_weather_/i, '').replace(/_/g, ' ')
  return (
    <div style={{
      marginBottom: 4,
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
      background: 'var(--surface)',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left',
          padding: '5px 10px',
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 11,
        }}
      >
        <span style={{
          background: 'var(--accent-dim)', color: 'var(--accent)',
          padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 600,
        }}>
          {label}
        </span>
        <span style={{ color: 'var(--text-secondary)', opacity: 0.7 }}>calling…</span>
        <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 10, color: 'var(--text-secondary)' }}>
          {open ? '▲' : '▼'}
        </span>
      </button>
      {open && (
        <pre style={{
          margin: 0, padding: '6px 12px 10px',
          borderTop: '1px solid var(--border)',
          fontSize: 10, color: 'var(--text-secondary)',
          overflowX: 'auto', maxHeight: 120, background: 'var(--surface)',
        }}>
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  )
}

function ToolResultBlock({ name, result }: { name: string; result: unknown }) {
  const [open, setOpen] = useState(false)
  const label = name.replace(/^tool_weather_/i, '').replace(/_/g, ' ')
  const hasData = result != null
  return (
    <div style={{
      marginBottom: 6,
      border: '1px solid var(--border)',
      borderRadius: 8,
      overflow: 'hidden',
      background: 'var(--surface)',
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left',
          padding: '5px 10px',
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 11,
        }}
      >
        <span style={{
          background: '#1a3a1a', color: '#4caf50',
          padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 600,
        }}>
          ✓ {label}
        </span>
        {hasData && (
          <span style={{ color: 'var(--text-secondary)', opacity: 0.6, fontSize: 10 }}>
            {open ? 'hide result' : 'show result'}
          </span>
        )}
        <span style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 10, color: 'var(--text-secondary)' }}>
          {open ? '▲' : '▼'}
        </span>
      </button>
      {open && hasData && (
        <pre style={{
          margin: 0, padding: '6px 12px 10px',
          borderTop: '1px solid var(--border)',
          fontSize: 10, color: 'var(--text-secondary)',
          overflowX: 'auto', maxHeight: 160, background: 'var(--surface)',
        }}>
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component

export default function AgentChat({ contextMessage, onContextConsumed, onMapFocus }: AgentChatProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)
  const abortRef  = useRef<AbortController | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!contextMessage) return
    setInput(contextMessage)
    onContextConsumed?.()
    inputRef.current?.focus()
  }, [contextMessage])

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || loading) return

    const userMsg: Message = { role: 'user', content: text.trim() }
    const history = messages.filter(m => !m.isStreaming)

    setMessages(prev => [...prev, userMsg, {
      role: 'assistant', content: '', blocks: [], isStreaming: true,
    }])
    setInput('')
    setLoading(true)

    abortRef.current = new AbortController()

    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text.trim(), history }),
        signal: abortRef.current.signal,
      })

      if (!res.ok || !res.body) {
        const err = await res.text()
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1
            ? { ...m, isStreaming: false, content: `Error: ${err}` }
            : m
        ))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentText = ''
      const blocks: StreamBlock[] = []

      const pushBlock = (b: StreamBlock) => {
        blocks.push(b)
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1
            ? { ...m, content: currentText, blocks: [...blocks], isStreaming: true }
            : m
        ))
      }

      const updateLast = () => {
        setMessages(prev => prev.map((m, i) =>
          i === prev.length - 1
            ? { ...m, content: currentText, blocks: [...blocks], isStreaming: true }
            : m
        ))
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          if (!part.trim()) continue
          let eventType = 'message'
          let dataStr = ''

          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) eventType = line.slice(6).trim()
            else if (line.startsWith('data:')) dataStr = line.slice(5).trim()
          }

          if (!dataStr) continue
          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(dataStr) } catch { continue }

          if (eventType === 'token') {
            currentText += (parsed.text as string ?? '')
            updateLast()

          } else if (eventType === 'thinking') {
            // Discard internal reasoning — not useful for end users

          } else if (eventType === 'tool_use') {
            const name  = (parsed.name as string) ?? 'tool'
            const inp   = parsed.input ?? {}
            pushBlock({ type: 'tool_use', name, input: inp })

          } else if (eventType === 'tool_result') {
            const name   = (parsed.name as string) ?? 'tool'
            const result = parsed.result ?? parsed
            pushBlock({ type: 'tool_result', name, result })

          } else if (eventType === 'status') {
            const label = parsed.label as string ?? ''
            // Replace existing status block or add new one
            const si = blocks.findIndex(b => b.type === 'status')
            if (si >= 0) (blocks[si] as { type: 'status'; label: string }).label = label
            else blocks.push({ type: 'status', label })
            updateLast()

          } else if (eventType === 'map_focus') {
            const bbox = parsed.bbox as { lat_min: number; lat_max: number; lon_min: number; lon_max: number }
            if (bbox && onMapFocus) onMapFocus(bbox)

          } else if (eventType === 'result') {
            const finalText = (parsed.text as string) || currentText
            currentText = finalText
            // Remove trailing status block (no longer needed)
            const si = blocks.findIndex(b => b.type === 'status')
            if (si >= 0) blocks.splice(si, 1)
            setMessages(prev => prev.map((m, i) =>
              i === prev.length - 1
                ? { ...m, content: finalText, blocks: [...blocks], isStreaming: false }
                : m
            ))

          } else if (eventType === 'error') {
            const errMsg = (parsed.error as string) ?? 'Unknown error'
            setMessages(prev => prev.map((m, i) =>
              i === prev.length - 1
                ? { ...m, content: `Error: ${errMsg}`, isStreaming: false }
                : m
            ))
          }
        }
      }

      // Finalise if stream ended without a result event
      setMessages(prev => prev.map((m, i) => {
        if (i !== prev.length - 1 || !m.isStreaming) return m
        const finalBlocks = (m.blocks ?? []).filter(b => b.type !== 'status')
        return { ...m, content: currentText || m.content, blocks: finalBlocks, isStreaming: false }
      }))

    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setMessages(prev => prev.map((m, i) =>
        i === prev.length - 1
          ? { ...m, isStreaming: false, content: `Error: ${String(err)}` }
          : m
      ))
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }, [messages, loading])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(input)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
    setLoading(false)
    setMessages(prev => prev.map((m, i) =>
      i === prev.length - 1 && m.isStreaming
        ? { ...m, isStreaming: false, content: m.content + ' [stopped]' }
        : m
    ))
  }

  const handleClear = () => {
    if (loading) handleStop()
    setMessages([])
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--surface)', borderLeft: '1px solid var(--border)',
    }}>
      {/* Header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: 'var(--surface)',
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Weather Agent</div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
            Powered by Met Office IceChunk data
          </div>
        </div>
        <button
          className="btn secondary small"
          style={{ fontSize: 11 }}
          onClick={handleClear}
          title="Clear conversation"
        >
          Clear
        </button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, textAlign: 'center', marginTop: 20 }}>
            <div style={{ marginBottom: 8 }}>Ask a weather question or click a point on the map</div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>
              e.g. "What's the temperature in the UK?"<br/>
              "How windy is it over Japan?"<br/>
              "Compare cloud cover over Europe"
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
          }}>
            {/* Rich stream blocks (thinking, tools) — assistant only */}
            {msg.role === 'assistant' && msg.blocks && msg.blocks.length > 0 && (
              <div style={{ width: '100%', maxWidth: '95%', marginBottom: 4 }}>
                {msg.blocks.map((block, j) => {
                  if (block.type === 'tool_use') {
                    return <ToolUseBlock key={j} name={block.name} input={block.input} />
                  }
                  if (block.type === 'tool_result') {
                    return <ToolResultBlock key={j} name={block.name} result={block.result} />
                  }
                  if (block.type === 'status') {
                    return (
                      <div key={j} style={{
                        fontSize: 10, color: 'var(--text-secondary)',
                        padding: '2px 6px', marginBottom: 3, opacity: 0.75,
                        display: 'flex', alignItems: 'center', gap: 5,
                      }}>
                        <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                        {block.label}
                      </div>
                    )
                  }
                  return null
                })}
              </div>
            )}

            {/* Main text bubble */}
            {(msg.content || msg.isStreaming) && (
              <div style={{
                maxWidth: '92%',
                padding: '8px 12px',
                borderRadius: msg.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                background: msg.role === 'user' ? 'var(--accent)' : 'var(--surface-2)',
                border: msg.role === 'assistant' ? '1px solid var(--border)' : 'none',
                color: msg.role === 'user' ? '#fff' : 'var(--text)',
                fontSize: 12,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {msg.role === 'assistant' && msg.content ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p:    ({ children }) => <p style={{ margin: '0 0 6px' }}>{children}</p>,
                      ul:   ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: 16 }}>{children}</ul>,
                      ol:   ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: 16 }}>{children}</ol>,
                      li:   ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
                      code: ({ children, className }) => className
                        ? <code style={{ display: 'block', background: 'var(--surface)', padding: '6px 8px', borderRadius: 4, fontSize: 10, overflowX: 'auto', whiteSpace: 'pre', margin: '4px 0' }}>{children}</code>
                        : <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 4px', borderRadius: 3, fontSize: 11 }}>{children}</code>,
                      table: ({ children }) => <table style={{ borderCollapse: 'collapse', fontSize: 11, margin: '6px 0', width: '100%' }}>{children}</table>,
                      th:   ({ children }) => <th style={{ border: '1px solid var(--border)', padding: '3px 6px', background: 'var(--surface)', textAlign: 'left', fontWeight: 600 }}>{children}</th>,
                      td:   ({ children }) => <td style={{ border: '1px solid var(--border)', padding: '3px 6px' }}>{children}</td>,
                      h1:   ({ children }) => <h1 style={{ fontSize: 13, fontWeight: 700, margin: '6px 0 3px' }}>{children}</h1>,
                      h2:   ({ children }) => <h2 style={{ fontSize: 12, fontWeight: 700, margin: '6px 0 3px' }}>{children}</h2>,
                      h3:   ({ children }) => <h3 style={{ fontSize: 12, fontWeight: 600, margin: '4px 0 2px' }}>{children}</h3>,
                      strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                ) : (
                  msg.content || ''
                )}
                {msg.isStreaming && <span style={{ opacity: 0.6, marginLeft: 4 }}>▌</span>}
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div style={{
        padding: '10px 12px',
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
      }}>
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about the weather… (Enter to send)"
            rows={2}
            style={{
              flex: 1, resize: 'none',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text)',
              fontFamily: 'inherit', fontSize: 12,
              padding: '7px 10px', lineHeight: 1.4,
            }}
          />
          {loading ? (
            <button type="button" className="btn danger small" onClick={handleStop} style={{ alignSelf: 'flex-end' }}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="btn primary small"
              disabled={!input.trim()}
              style={{ alignSelf: 'flex-end' }}
            >
              Send
            </button>
          )}
        </form>
        <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
          Click any point on the map to ask about it · Shift+Enter for new line
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
      `}</style>
    </div>
  )
}
