import express, { Request, Response } from 'express'
import path from 'path'
import { spawnSync } from 'child_process'
import https from 'https'
import fs from 'fs'
import zlib from 'zlib'

const app = express()
app.use(express.json({ limit: '10mb' }))

// Log every request so we can see traffic in SYSTEM$GET_SERVICE_LOGS
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`)
  next()
})

const PORT = parseInt(process.env.PORT ?? '3001', 10)
const DIST = path.join(__dirname, '../dist')

// ── Snowflake connection ──────────────────────────────────────────────────────

// SPCS auto-injects SNOWFLAKE_HOST and SNOWFLAKE_TOKEN
// SNOWFLAKE_HOST: e.g. "sfsehol-internal-marketplace.snowflakecomputing.com"
// SNOWFLAKE_TOKEN: JWT for the service's identity (used for service-to-SF calls)
const SF_HOST      = process.env.SNOWFLAKE_HOST     ?? ''
const SF_DATABASE  = process.env.SNOWFLAKE_DATABASE ?? 'ICECHUNK_DB'
const SF_SCHEMA    = process.env.SNOWFLAKE_SCHEMA   ?? 'ICECHUNK'
const SF_WAREHOUSE = process.env.SNOWFLAKE_WAREHOUSE ?? 'XSMALL'

/**
 * Read the SPCS service identity token.
 * Snowflake mounts it at /snowflake/session/token; env var SNOWFLAKE_TOKEN
 * is also set in some SPCS versions.  Try both.
 */
function getServiceToken(): string {
  // 1. env var (some SPCS versions)
  if (process.env.SNOWFLAKE_TOKEN) return process.env.SNOWFLAKE_TOKEN
  // 2. mounted token file (standard SPCS)
  try {
    const t = fs.readFileSync('/snowflake/session/token', 'utf8').trim()
    if (t) return t
  } catch { /* file not present */ }
  return ''
}


/**
 * Run SQL via SPCS.
 *
 * In SPCS, the user's Authorization header is forwarded by the ingress proxy
 * on every request.  We extract it and pass it directly to the Snowflake
 * REST API so the query runs under the caller's role (ICECHUNK_DB).
 *
 * If no user token is present, fall back to the service identity token
 * (SNOWFLAKE_TOKEN) which runs as the service's compute pool role.
 */
async function snowSqlSpcs(
  sql: string,
  database: string | undefined,
  schema: string | undefined,
  _userAuthHeader?: string        // kept for API compat but not used — CSRF issue
): Promise<unknown[]> {
  // Derive host: explicit env var, or build from account identifier
  const host = SF_HOST ||
    (process.env.SNOWFLAKE_ACCOUNT
      ? `${process.env.SNOWFLAKE_ACCOUNT.toLowerCase().replace(/_/g, '-')}.snowflakecomputing.com`
      : '')
  if (!host) throw new Error('Neither SNOWFLAKE_HOST nor SNOWFLAKE_ACCOUNT is set')

  const db  = database ?? SF_DATABASE
  const sch = schema   ?? SF_SCHEMA
  const wh  = SF_WAREHOUSE

  // Always use the SPCS service identity token.
  // The browser's forwarded SPCS proxy token is a CSRF-protected session token
  // that cannot be used as a Bearer token in the SQL REST API — it causes
  // "CSRF tokens mismatch". The service token has all needed grants.
  const authToken = getServiceToken()
  if (!authToken) throw new Error('No service token: /snowflake/session/token not found. Is this running in SPCS?')

  const body = JSON.stringify({
    statement: sql,
    database: db,
    schema: sch,
    warehouse: wh,
    timeout: 120,
  })

  return new Promise((resolve, reject) => {
    const baseHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'identity',
      'Authorization': `Bearer ${authToken}`,
      'X-Snowflake-Authorization-Token-Type': 'OAUTH',
      'User-Agent': 'icechunk-accelerator/1.0',
    }

    /**
     * Fetch a single partition.
     * `knownCols` must be supplied for partition GETs (index >= 1) because
     * Snowflake omits resultSetMetaData from all but the first response.
     */
    function fetchPartition(
      path: string,
      knownCols?: string[]
    ): Promise<{ cols: string[]; rows: unknown[] }> {
      return new Promise((res, rej) => {
        const method = path === '/api/v2/statements' ? 'POST' : 'GET'
        const opts = { hostname: host, path, method, headers: baseHeaders }
        const request = https.request(opts, httpRes => {
          const chunks: Buffer[] = []
          httpRes.on('data', (chunk: Buffer) => chunks.push(chunk))
          httpRes.on('end', () => {
            const raw = Buffer.concat(chunks)
            const encoding = httpRes.headers['content-encoding']

            const parseResponse = (text: string) => {
              try {
                if (httpRes.statusCode && (httpRes.statusCode < 200 || httpRes.statusCode >= 300)) {
                  rej(new Error(`SF API HTTP ${httpRes.statusCode}: ${text.slice(0, 200)}`))
                  return
                }
                const json = JSON.parse(text)
                if (json.message && json.sqlState && json.sqlState !== '00000') {
                  rej(new Error(json.message)); return
                }
                // Use metadata from this response, or fall back to cols passed in
                // (partition GETs don't include resultSetMetaData)
                const cols: string[] = json.resultSetMetaData?.rowType
                  ? json.resultSetMetaData.rowType.map((c: { name: string }) => c.name)
                  : (knownCols ?? [])
                const rows = (json.data ?? []).map((row: string[]) => {
                  const obj: Record<string, unknown> = {}
                  cols.forEach((c, i) => { obj[c] = row[i] })
                  return obj
                })
                ;(res as unknown as (v: { cols: string[]; rows: unknown[]; handle?: string; partitions?: number }) => void)(
                  { cols, rows, handle: json.statementHandle, partitions: json.resultSetMetaData?.partitionInfo?.length ?? 1 }
                )
              } catch {
                rej(new Error(`SF API parse error: ${text.slice(0, 400)}`))
              }
            }

            if (encoding === 'gzip' || encoding === 'deflate') {
              zlib.gunzip(raw, (err, decompressed) => {
                if (err) { rej(new Error(`SF API decompress error: ${err.message}`)); return }
                parseResponse(decompressed.toString('utf8'))
              })
            } else {
              parseResponse(raw.toString('utf8'))
            }
          })
        })
        request.on('error', rej)
        if (method === 'POST') request.write(body)
        request.end()
      })
    }

    // Initial POST
    fetchPartition('/api/v2/statements')
      .then(async (first) => {
        const { cols, rows: firstRows, handle, partitions } = first as {
          cols: string[]; rows: unknown[]; handle?: string; partitions?: number
        }
        console.log(`SF API: ${partitions ?? 1} partition(s), handle=${handle?.slice(0, 12) ?? 'none'}`)

        if (!handle || !partitions || partitions <= 1) {
          resolve(firstRows)
          return
        }

        // Fetch all remaining partitions in parallel — each partition GET is
        // independent so there is no reason to await them sequentially.
        // For N partitions this reduces latency from N×T to ~1×T.
        const partitionPromises = Array.from(
          { length: partitions - 1 },
          (_, i) => fetchPartition(`/api/v2/statements/${handle}?partition=${i + 1}`, cols) as Promise<{ cols: string[]; rows: unknown[] }>
        )
        const remaining = await Promise.all(partitionPromises)
        const allRows: unknown[] = [...firstRows]
        remaining.forEach(part => allRows.push(...part.rows))
        console.log(`SF API: total rows fetched = ${allRows.length} (${partitions} partitions, parallel)`)
        resolve(allRows)
      })
      .catch(reject)
  })
}

/**
 * Run SQL locally via `snow sql` CLI (development only).
 */
function snowSqlLocal(sql: string, database?: string, schema?: string): unknown[] {
  const db  = (database ?? SF_DATABASE).replace(/[^A-Za-z0-9_]/g, '')
  const sch = (schema   ?? SF_SCHEMA  ).replace(/[^A-Za-z0-9_]/g, '')

  const result = spawnSync('snow', [
    'sql', '-c', 'internal-marketplace',
    '-q', sql,
    '--database', db,
    '--schema', sch,
    '--format', 'json',
  ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })

  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'snow sql failed')

  const out = result.stdout?.trim()
  if (!out) return []
  const start = out.indexOf('[')
  if (start === -1) return []
  return JSON.parse(out.slice(start))
}

// Detect SPCS: check both SNOWFLAKE_HOST (not always auto-injected) and SNOWFLAKE_TOKEN
const isSpcs = !!(SF_HOST || process.env.SNOWFLAKE_TOKEN)

async function runSql(
  sql: string,
  database?: string,
  schema?: string,
  userAuthHeader?: string
): Promise<unknown[]> {
  if (isSpcs) return snowSqlSpcs(sql, database, schema, userAuthHeader)
  return snowSqlLocal(sql, database, schema)
}

// ── Tile proxy (CARTO dark matter) ────────────────────────────────────────────

const tileCache = new Map<string, { data: Buffer; ts: number }>()
const TILE_TTL = 60 * 60 * 1000
const TILE_MAX = 5000

app.get('/api/tiles/:z/:x/:y', (req: Request, res: Response) => {
  const z = String(req.params.z), x = String(req.params.x), y = String(req.params.y)
  const key = `${z}/${x}/${y}`
  const cached = tileCache.get(key)
  if (cached && Date.now() - cached.ts < TILE_TTL) {
    res.setHeader('Content-Type', 'image/png')
    res.send(cached.data)
    return
  }
  // Use subdomain that matches the EAI network rule (a/b/c/d.basemaps.cartocdn.com)
  // Note: dark_matter_nolabels returns 502 — use dark_all instead
  const sub = ['a', 'b', 'c', 'd'][(parseInt(z) + parseInt(x) + parseInt(y)) % 4]
  https.get(`https://${sub}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`, tileRes => {
    const chunks: Buffer[] = []
    tileRes.on('data', chunk => chunks.push(chunk as Buffer))
    tileRes.on('end', () => {
      const buf = Buffer.concat(chunks)
      if (tileCache.size >= TILE_MAX) {
        const oldest = [...tileCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]
        tileCache.delete(oldest[0])
      }
      tileCache.set(key, { data: buf, ts: Date.now() })
      res.setHeader('Content-Type', 'image/png')
      res.send(buf)
    })
  }).on('error', err => {
    console.error('Tile fetch error', err.message)
    res.status(502).send('Tile fetch failed')
  })
})

// ── SQL proxy ─────────────────────────────────────────────────────────────────

const ALLOWED_SQL = /^\s*(SELECT|SHOW|DESCRIBE|DESC|WITH|CALL)\b/i

app.post('/api/query', async (req: Request, res: Response) => {
  const { sql, database, schema } = req.body as {
    sql?: string; database?: string; schema?: string
  }
  if (!sql) { res.status(400).json({ error: 'Missing sql' }); return }
  const trimmed = sql.trim()
  if (!ALLOWED_SQL.test(trimmed)) {
    res.status(400).json({ error: 'Only SELECT/SHOW/DESCRIBE/WITH/CALL allowed' })
    return
  }
  try {
    const rows = await runSql(trimmed, database, schema)
    res.json({ result: rows })
  } catch (err) {
    console.error(new Date().toISOString(), '[/api/query]', String(err))
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ── Snapshots endpoint ─────────────────────────────────────────────────────────

/** Parse a Met Office run stamp from a tag like "met_office_2026-06-02_T0000Z" */
function parseTagLabel(tag: string): string | null {
  // Format 1: met_office_YYYY-MM-DD_THHMMZ
  const m1 = tag.match(/met_office_(\d{4}-\d{2}-\d{2})_T(\d{2})(\d{2})Z/)
  if (m1) return `${m1[1]} ${m1[2]}:${m1[3]}Z`
  // Format 2: met_office_YYYYMMDD_THHMMZ
  const m2 = tag.match(/met_office_(\d{4})(\d{2})(\d{2})_T(\d{2})(\d{2})Z/)
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]} ${m2[4]}:${m2[5]}Z`
  return null
}

app.get('/api/snapshots', async (_req: Request, res: Response) => {
  try {
    const rows = await runSql(
      `SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_META() AS result`,
      'ICECHUNK_DB', 'ICECHUNK'
    ) as Record<string, unknown>[]
    const raw = rows[0]?.RESULT ?? rows[0]?.result
    const meta = typeof raw === 'string' ? JSON.parse(raw) : raw as {
      latest_snapshot: string
      tags: string[]
    }
    const latestSnapshot: string = meta.latest_snapshot ?? ''
    const tags: string[] = Array.isArray(meta.tags) ? meta.tags : []

    // Extract run-date tags (met_office_... pattern)
    // All current tags map to latest_snapshot because ICECHUNK_META only exposes
    // the current snapshot.  When ICECHUNK_HISTORY or ICECHUNK_SNAPSHOT_FOR_TAG
    // is available, this list will contain multiple distinct snapshotIds.
    const snapshots = tags
      .map(tag => ({ tag, label: parseTagLabel(tag), snapshotId: latestSnapshot }))
      .filter((s): s is { tag: string; label: string; snapshotId: string } => s.label !== null)

    res.json({ snapshots, latestSnapshot })
  } catch (err) {
    console.error(new Date().toISOString(), '[/api/snapshots]', String(err))
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ── UK 2km Seed endpoint ──────────────────────────────────────────────────────

app.post('/api/ingest_uk', async (_req: Request, res: Response) => {
  // Calls ICECHUNK_SEED_UK() which downloads the latest available hourly
  // UK 2km run from ASDI, reprojects OSGB36 → WGS84, and writes to IceChunk.
  console.log(new Date().toISOString(), '[/api/ingest_uk] Calling ICECHUNK_SEED_UK()')
  try {
    const rows = await runSql(
      `SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED_UK() AS result`,
      'ICECHUNK_DB', 'ICECHUNK'
    ) as Record<string, unknown>[]
    const raw = rows[0]?.RESULT ?? rows[0]?.result ?? {}
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw as Record<string, unknown>
    const runStamp = parsed.run_stamp ?? parsed.tag ?? 'unknown'
    res.json({
      status: 'done',
      run_stamp: runStamp,
      snapshot_id: parsed.snapshot_id ?? null,
      variables: parsed.variables ?? [],
      grid: parsed.grid ?? null,
      message: parsed.message ?? `Loaded UK 2km run: ${runStamp}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(new Date().toISOString(), '[/api/ingest_uk]', msg)
    res.status(500).json({ error: msg })
  }
})

// ── Ingest endpoint ───────────────────────────────────────────────────────────

app.post('/api/ingest', async (_req: Request, res: Response) => {
  // Note: ICECHUNK_SEED() takes no arguments — the function determines the date internally.
  console.log(new Date().toISOString(), '[/api/ingest] Calling ICECHUNK_SEED()')
  try {
    const rows = await runSql(
      `SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED() AS result`,
      'ICECHUNK_DB', 'ICECHUNK'
    ) as Record<string, unknown>[]
    const raw = rows[0]?.RESULT ?? rows[0]?.result ?? {}
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw as Record<string, unknown>
    const actualRunStamp = parsed.run_stamp ?? parsed.tag ?? 'unknown'
    res.json({
      status: 'done', run_stamp: actualRunStamp,
      snapshot_id: parsed.snapshot_id ?? null,
      message: `Loaded latest available Met Office run: ${actualRunStamp}`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(new Date().toISOString(), '[/api/ingest]', msg)
    // Detect the known "tag immutable" failure from ICECHUNK_SEED
    if (msg.includes('tag already exists') || msg.includes('tags are immutable')) {
      res.status(409).json({
        error: 'ICECHUNK_SEED() failed: the v1.0 tag already exists and is immutable. ' +
               'The IceChunk Python service needs to be updated to skip tag creation when the tag exists. ' +
               'Please contact the service owner to fix ICECHUNK_SEED().',
        tag_conflict: true,
      })
    } else {
      res.status(500).json({ error: msg })
    }
  }
})

// ── Save to Snowflake table ───────────────────────────────────────────────────

app.post('/api/save-table', async (req: Request, res: Response) => {
  const {
    table_name,
    lat_min, lat_max, lon_min, lon_max,
    snapshot_id,
    variables,
    pivoted,
    dataset,
  } = req.body as {
    table_name?: string
    lat_min?: number; lat_max?: number; lon_min?: number; lon_max?: number
    snapshot_id?: string | null
    variables?: string[]
    pivoted?: boolean
    dataset?: string
  }

  // Validate inputs
  if (!table_name || typeof table_name !== 'string') {
    res.status(400).json({ error: 'Missing table_name' }); return
  }
  if (!variables?.length) {
    res.status(400).json({ error: 'Missing variables list' }); return
  }

  // Sanitise table name: only alphanumerics and underscores
  const safeName = table_name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
  if (!safeName) {
    res.status(400).json({ error: 'Invalid table name' }); return
  }

  const snapshotExpr = snapshot_id ? `'${snapshot_id.replace(/'/g, "''")}'` : 'NULL'
  const latMin  = Number(lat_min)
  const latMax  = Number(lat_max)
  const lonMin  = Number(lon_min)
  const lonMax  = Number(lon_max)

  // Build SQL — either UNION ALL long format or pivoted wide format
  // UK dataset uses ICECHUNK_SLICE_UK (LAEA→WGS84 coords stored at ingest).
  const isUk = dataset === 'uk'
  const sliceFn = isUk ? 'ICECHUNK_SLICE_UK' : 'ICECHUNK_SLICE'
  const branches = variables.map(v => {
    const safeVar = v.replace(/[^A-Za-z0-9_]/g, '')
    return `
  SELECT '${safeVar}'  AS variable,
         f.value:lat::FLOAT   AS lat,
         f.value:lon::FLOAT   AS lon,
         H3_INT_TO_STRING(
           H3_LATLNG_TO_CELL(f.value:lat::FLOAT, f.value:lon::FLOAT, 5)
         ) AS h3_cell,
         f.value:value::FLOAT AS value,
         ${snapshotExpr}      AS snapshot_id,
         CURRENT_TIMESTAMP()  AS created_at
  FROM (SELECT ICECHUNK_DB.ICECHUNK.${sliceFn}(
          '${safeVar}', ${latMin}, ${latMax}, ${lonMin}, ${lonMax}, ${snapshotExpr}
        ) AS r) t,
  LATERAL FLATTEN(input => t.r:data) f`
  })

  // Long format: UNION ALL of all variable branches
  const longSql = `CREATE OR REPLACE TABLE ICECHUNK_DB.ICECHUNK.${safeName} AS\n`
    + branches.join('\nUNION ALL\n')

  // Wide (pivoted) format: UNION ALL as a subquery, then conditional aggregation
  // Each variable gets its own column; rows are keyed by (lat, lon, h3_cell).
  const wideSelectCols = variables
    .map(v => {
      const safeVar = v.replace(/[^A-Za-z0-9_]/g, '')
      return `  MAX(CASE WHEN variable = '${safeVar}' THEN value END) AS ${safeVar}`
    })
    .join(',\n')

  const wideSql = `CREATE OR REPLACE TABLE ICECHUNK_DB.ICECHUNK.${safeName} AS
SELECT lat,
       lon,
       h3_cell,
${wideSelectCols},
       snapshot_id,
       MAX(created_at) AS created_at
FROM (\n${branches.join('\nUNION ALL\n')}\n) base
GROUP BY lat, lon, h3_cell, snapshot_id`

  const createSql = pivoted ? wideSql : longSql

  console.log(new Date().toISOString(),
    `[/api/save-table] Creating ICECHUNK_DB.ICECHUNK.${safeName} (${variables.length} variables, ${pivoted ? 'wide/pivoted' : 'long'} format)`)

  try {
    await runSql(createSql, 'ICECHUNK_DB', 'ICECHUNK')

    // Count rows so we can report back to the UI
    const countRows = await runSql(
      `SELECT COUNT(*) AS n FROM ICECHUNK_DB.ICECHUNK.${safeName}`,
      'ICECHUNK_DB', 'ICECHUNK'
    ) as Record<string, unknown>[]
    const rowCount = Number(countRows[0]?.N ?? countRows[0]?.n ?? 0)

    console.log(new Date().toISOString(),
      `[/api/save-table] Done: ${rowCount} rows in ICECHUNK_DB.ICECHUNK.${safeName}`)

    res.json({
      table: `ICECHUNK_DB.ICECHUNK.${safeName}`,
      row_count: rowCount,
      variables: variables.length,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(new Date().toISOString(), '[/api/save-table]', msg)
    res.status(500).json({ error: msg })
  }
})

// ── Cortex Agent chat (SSE streaming) ─────────────────────────────────────────
//
// URL: /api/v2/databases/{DB}/schemas/{SCHEMA}/agents/{NAME}:run
// Body: { messages: [...], stream: true }
//
// SSE events emitted to browser:
//   token    → {text}                    streaming answer text
//   thinking → {text}                    streaming reasoning/thinking
//   tool_use → {name, input}             tool call starting
//   tool_result → {name, result}         tool result received
//   status   → {label}                   status update
//   result   → {text, tool_results}      final answer complete
//   error    → {error}                   error

const AGENT_DB     = 'ICECHUNK_DB'
const AGENT_SCHEMA = 'ICECHUNK'
const AGENT_NAME   = 'WEATHER_AGENT'

app.post('/api/agent/chat', async (req: Request, res: Response) => {
  const { message, history = [] } = req.body as {
    message?: string
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
  }

  if (!message) { res.status(400).json({ error: 'Missing message' }); return }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const emit = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const host = SF_HOST || process.env.SNOWFLAKE_HOST || ''

  if (!host) {
    emit('error', { error: 'SNOWFLAKE_HOST not set' })
    res.end(); return
  }

  // Always use the SPCS service identity token for the Cortex Agent API.
  // The browser's forwarded Authorization header runs as the browser user's
  // role (e.g. SALES_ENGINEER) which does not have USAGE on WEATHER_AGENT.
  // The service token runs as ICECHUNK user → ICECHUNK_DB role, which has
  // USAGE on the agent, tool procedures, and SNOWFLAKE.CORTEX_USER.
  const authToken = getServiceToken()
  if (!authToken) { emit('error', { error: 'No SPCS service token — is this running in SPCS?' }); res.end(); return }

  const messages = [
    ...history.map(h => ({ role: h.role, content: [{ type: 'text', text: h.content }] })),
    { role: 'user', content: [{ type: 'text', text: message }] },
  ]

  // Snowflake Cortex Agent REST API — URL format matches fleet intelligence pattern
  const agentUrl = `https://${host}/api/v2/databases/${AGENT_DB}/schemas/${AGENT_SCHEMA}/agents/${AGENT_NAME}:run`
  console.log(new Date().toISOString(), `[/api/agent/chat] → ${agentUrl.split('/').pop()} (${messages.length} turns)`)

  try {
    const agentRes = await fetch(agentUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'X-Snowflake-Authorization-Token-Type': 'OAUTH',
        'User-Agent': 'icechunk-accelerator/1.0',
      },
      body: JSON.stringify({ messages, stream: true }),
    })

    if (!agentRes.ok) {
      const errText = await agentRes.text()
      const msg = `Cortex Agent API ${agentRes.status}: ${errText.slice(0, 400)}`
      console.error(new Date().toISOString(), '[/api/agent/chat]', msg)
      emit('error', { error: msg })
      res.end(); return
    }

    const reader = agentRes.body?.getReader()
    if (!reader) { emit('error', { error: 'No readable body from agent API' }); res.end(); return }

    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    const toolResults: unknown[] = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      let currentEvent = ''
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim()
          continue
        }
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (!data || data === '[DONE]') continue

        let parsed: Record<string, unknown>
        try { parsed = JSON.parse(data) } catch { continue }

        switch (currentEvent) {
          case 'response.text.delta': {
            const text = parsed.text as string ?? ''
            if (text) { fullText += text; emit('token', { text }) }
            break
          }
          case 'response.thinking.delta': {
            const thinking = parsed.thinking as string ?? ''
            if (thinking) emit('thinking', { text: thinking })
            break
          }
          case 'response.tool_use': {
            const name   = parsed.name as string ?? 'tool'
            const input  = parsed.input as unknown ?? {}
            emit('tool_use', { name, input })
            emit('status', { label: `Running ${name.replace('tool_', '')}…` })
            break
          }
          case 'response.tool_result': {
            const name = parsed.name as string ?? 'tool'
            // Extract result content from nested structure
            let resultObj: unknown = parsed
            const content = (parsed.content as unknown[]) ?? []
            for (const c of content) {
              const item = c as Record<string, unknown>
              if (item.type === 'json' && item.json) {
                // Unwrap nested .result string if present (procedure wrapper)
                const raw = item.json as Record<string, unknown>
                if (typeof raw.result === 'string') {
                  try { resultObj = JSON.parse(raw.result) } catch { resultObj = raw }
                } else {
                  resultObj = raw
                }
                break
              }
              if (item.type === 'text' && item.text) {
                try { resultObj = JSON.parse(item.text as string) } catch { resultObj = item.text }
                break
              }
            }
            toolResults.push(resultObj)
            emit('tool_result', { name, result: resultObj })

            // If the tool result contains a bbox, emit map_focus so the
            // frontend can zoom the DeckGL map to the queried region.
            const bbox = (resultObj as Record<string, unknown>)?.bbox as Record<string, number> | undefined
            if (bbox && bbox.lat_min != null && bbox.lat_max != null &&
                bbox.lon_min != null && bbox.lon_max != null) {
              emit('map_focus', { bbox })
            }
            break
          }
          case 'response.status': {
            const label = (parsed.message ?? parsed.status ?? 'Processing') as string
            emit('status', { label })
            break
          }
          case 'response': {
            // Final non-streaming response (if stream ended before message_stop)
            if (parsed.content) {
              for (const item of (parsed.content as Record<string, unknown>[]) ?? []) {
                if (item.type === 'text' && !fullText) fullText = item.text as string
              }
            }
            break
          }
          case 'error': {
            emit('error', { error: parsed.error ?? parsed.message ?? data })
            break
          }
        }
      }
    }

    emit('result', { text: fullText || 'No response from agent.', tool_results: toolResults })
    console.log(new Date().toISOString(), `[/api/agent/chat] complete (${fullText.length} chars, ${toolResults.length} tool results)`)

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(new Date().toISOString(), '[/api/agent/chat]', msg)
    emit('error', { error: msg })
  }

  res.end()
})

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/api/health', (_req: Request, res: Response) => {
  const svcToken = getServiceToken()
  res.json({
    status: 'ok',
    service: 'icechunk-accelerator',
    spcs_mode: isSpcs,
    sf_host: SF_HOST || '(not set)',
    has_service_token: !!svcToken,
    token_source: svcToken
      ? (process.env.SNOWFLAKE_TOKEN ? 'env' : 'file')
      : 'none',
  })
})

// ── Debug: dump request headers (helps diagnose SPCS auth forwarding) ────────

app.get('/api/debug/headers', (req: Request, res: Response) => {
  const svcToken = getServiceToken()
  res.json({
    headers: req.headers,
    spcs_mode: isSpcs,
    sf_host: SF_HOST || '(not set)',
    has_service_token: !!svcToken,
    env_keys: Object.keys(process.env).filter(k =>
      k.toLowerCase().includes('snowflake') || k.toLowerCase().includes('sf_')
    ),
  })
})

// ── Static SPA ────────────────────────────────────────────────────────────────

app.use(express.static(DIST))
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(DIST, 'index.html'))
})

app.listen(PORT, () => {
  const svcToken = getServiceToken()
  console.log(`IceChunk Accelerator listening on port ${PORT}`)
  console.log(`SPCS mode: ${isSpcs}, SF host: ${SF_HOST || '(local)'}`)
  console.log(`Service token: ${svcToken ? `present (${svcToken.length} chars, source: ${process.env.SNOWFLAKE_TOKEN ? 'env' : 'file'})` : 'MISSING'}`)
  // Log all snowflake-related env vars at startup
  const sfVars = Object.keys(process.env).filter(k => k.toUpperCase().includes('SNOWFLAKE') || k.toUpperCase().startsWith('SF_'))
  console.log(`Snowflake env vars: ${sfVars.join(', ') || 'none'}`)
  // Check token file
  try { fs.accessSync('/snowflake/session/token'); console.log('Token file /snowflake/session/token: EXISTS') }
  catch { console.log('Token file /snowflake/session/token: NOT FOUND') }
})
