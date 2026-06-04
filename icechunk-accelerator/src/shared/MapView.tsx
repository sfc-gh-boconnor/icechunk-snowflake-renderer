'use client'
import React, { useEffect, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { Layer, PickingInfo, ViewStateChangeParameters } from '@deck.gl/core'
import { cartoBasemap } from './helpers'

interface ViewState {
  longitude: number
  latitude: number
  zoom: number
  pitch: number
  bearing: number
}

interface MapViewProps {
  layers?: Layer[]
  initialViewState?: ViewState
  getTooltip?: (info: PickingInfo) => { html: string; className?: string } | null
  onViewStateChange?: (params: ViewStateChangeParameters) => void
  onClick?: (info: PickingInfo) => void
  children?: React.ReactNode
}

const DEFAULT_VIEW_STATE: ViewState = {
  longitude: -3,
  latitude: 54,
  zoom: 4.5,
  pitch: 0,
  bearing: 0,
}

export default function MapView({
  layers = [],
  initialViewState,
  getTooltip,
  onViewStateChange,
  onClick,
  children,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null)
  const [viewState, setViewState] = useState<ViewState>(
    initialViewState ?? DEFAULT_VIEW_STATE
  )

  // Measure container dimensions via ResizeObserver
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const { width, height } = el.getBoundingClientRect()
      if (width > 0 && height > 0) setDims({ width, height })
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    const t = setTimeout(measure, 500)
    return () => {
      ro.disconnect()
      clearTimeout(t)
    }
  }, [])

  // Sync viewState when initialViewState prop changes (e.g. agent map focus)
  useEffect(() => {
    if (!initialViewState) return
    setViewState(prev => {
      if (
        Math.abs(prev.latitude  - initialViewState.latitude)  > 0.0001 ||
        Math.abs(prev.longitude - initialViewState.longitude) > 0.0001 ||
        Math.abs(prev.zoom      - initialViewState.zoom)      > 0.01
      ) {
        return initialViewState
      }
      return prev
    })
  }, [initialViewState])

  const allLayers = [cartoBasemap(), ...layers]

  return (
    <div
      ref={containerRef}
      className="map-canvas-wrap"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {dims && (
        <DeckGL
          width={dims.width}
          height={dims.height}
          viewState={viewState}
          controller={true}
          layers={allLayers}
          getTooltip={getTooltip}
          onViewStateChange={params => {
            const vs = params.viewState as ViewState
            setViewState(vs)
            onViewStateChange?.(params)
          }}
          onClick={onClick}
          style={{ position: 'absolute', top: '0', left: '0' }}
        >
          {children}
        </DeckGL>
      )}
    </div>
  )
}
