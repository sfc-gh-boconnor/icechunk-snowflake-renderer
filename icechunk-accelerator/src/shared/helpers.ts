import { TileLayer } from '@deck.gl/geo-layers'
import { BitmapLayer } from '@deck.gl/layers'

/**
 * CARTO dark matter basemap tiles proxied through the local Express server.
 * Identical pattern to fleet intelligence app.
 */
export function cartoBasemap() {
  return new TileLayer({
    id: 'carto-basemap',
    data: '/api/tiles/{z}/{x}/{y}',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props: Record<string, unknown>) => {
      const { boundingBox } = props.tile as {
        boundingBox: [[number, number], [number, number]]
      }
      const [[west, south], [east, north]] = boundingBox
      return new BitmapLayer(props, {
        data: undefined,
        image: props.data as string | null,
        bounds: [west, south, east, north],
      })
    },
  })
}

/**
 * POST a SQL statement to the local Express /api/query proxy.
 * Returns rows[] or [] on error.
 */
export async function sfQuery(
  sql: string,
  database?: string,
  schema?: string
): Promise<Record<string, unknown>[]> {
  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, database, schema }),
    })
    if (!res.ok) {
      console.error('sfQuery HTTP error', res.status, await res.text())
      return []
    }
    const body = await res.json()
    if (Array.isArray(body)) return body
    if (Array.isArray(body?.result)) return body.result
    return []
  } catch (err) {
    console.error('sfQuery error', err)
    return []
  }
}

/**
 * Trigger Met Office data ingestion via the /api/ingest endpoint.
 */
export async function triggerIngest(
  runStamp: string,
  files: string[]
): Promise<{ status: string; snapshot_id?: string; error?: string }> {
  try {
    const res = await fetch('/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_stamp: runStamp, files }),
    })
    const body = await res.json()
    if (!res.ok) return { status: 'error', error: body.error ?? 'Unknown error' }
    return body
  } catch (err) {
    return { status: 'error', error: String(err) }
  }
}
