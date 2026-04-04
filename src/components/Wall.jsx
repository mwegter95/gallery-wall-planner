import { useRef, useState, useEffect, useCallback } from 'react'
import Piece from './Piece'

export default function Wall({
  pieces, selectedId, onSelect, onMove, onResize, onDeselect,
  snapToGrid, gridSize, wallWidth, wallHeight,
  wallImage, onCalibrate,
}) {
  const containerRef = useRef(null)
  const [baseScale, setBaseScale] = useState(5)   // px per inch
  const [zoom, setZoom]           = useState(1.0)
  const [showRulers, setShowRulers] = useState(true)

  /* Auto-compute base scale to fill the container */
  useEffect(() => {
    const update = () => {
      if (!containerRef.current) return
      const pad = 80
      const { clientWidth: cw, clientHeight: ch } = containerRef.current
      const sx = (cw - pad) / wallWidth
      const sy = (ch - pad) / wallHeight
      setBaseScale(Math.min(sx, sy))
    }
    update()
    const ro = new ResizeObserver(update)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [wallWidth, wallHeight])

  const scale = baseScale * zoom
  const wPx   = wallWidth  * scale
  const hPx   = wallHeight * scale

  /* Ruler ticks every 12" (1 foot) */
  const footTicks = []
  for (let i = 0; i <= wallWidth; i += 12) {
    footTicks.push({ pos: i * scale, label: `${i / 12}'` })
  }
  const footTicksH = []
  for (let i = 0; i <= wallHeight; i += 12) {
    footTicksH.push({ pos: i * scale, label: `${i / 12}'` })
  }

  const handleBgClick = useCallback((e) => {
    if (e.target === e.currentTarget) onDeselect()
  }, [onDeselect])

  return (
    <div className="wall-container" ref={containerRef}>
      {/* Controls bar */}
      <div className="wall-controls">
        <div className="zoom-group">
          <button className="zoom-btn" onClick={() => setZoom(z => Math.max(0.2, +(z - 0.1).toFixed(2)))}>−</button>
          <button className="zoom-reset" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button className="zoom-btn" onClick={() => setZoom(z => Math.min(4, +(z + 0.1).toFixed(2)))}>+</button>
        </div>
        <button
          className={`ctrl-btn ${showRulers ? 'active' : ''}`}
          onClick={() => setShowRulers(r => !r)}
          title="Toggle rulers"
        >
          📏 Rulers
        </button>
        {snapToGrid && (
          <span className="snap-badge">⊞ Snap {gridSize}"</span>
        )}
        <span className="piece-count">{pieces.length} piece{pieces.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Scroll area */}
      <div className="wall-scroll">
        <div className="wall-centering">

          {/* Ruler wrapper */}
          <div className="ruler-wrapper" style={{ paddingLeft: showRulers ? 28 : 0, paddingTop: showRulers ? 28 : 0 }}>

            {/* Top ruler */}
            {showRulers && (
              <div className="ruler ruler-h" style={{ width: wPx, marginLeft: 28 }}>
                {footTicks.map(t => (
                  <div key={t.pos} className="ruler-tick" style={{ left: t.pos }}>
                    <span className="ruler-label">{t.label}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex' }}>
              {/* Left ruler */}
              {showRulers && (
                <div className="ruler ruler-v" style={{ height: hPx }}>
                  {footTicksH.map(t => (
                    <div key={t.pos} className="ruler-tick-v" style={{ top: t.pos }}>
                      <span className="ruler-label-v">{t.label}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* The actual wall */}
              <div
                className="wall"
                style={{
                  width: wPx,
                  height: hPx,
                  backgroundImage: wallImage ? `url(${wallImage})` : 'none',
                }}
                onClick={handleBgClick}
              >
                {/* Grid overlay */}
                {snapToGrid && (
                  <svg
                    className="grid-svg"
                    width={wPx}
                    height={hPx}
                    style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
                  >
                    <defs>
                      <pattern
                        id="grid-pat"
                        width={gridSize * scale}
                        height={gridSize * scale}
                        patternUnits="userSpaceOnUse"
                      >
                        <path
                          d={`M ${gridSize * scale} 0 L 0 0 0 ${gridSize * scale}`}
                          fill="none"
                          stroke="rgba(255,255,255,0.18)"
                          strokeWidth="0.6"
                        />
                      </pattern>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#grid-pat)" />
                  </svg>
                )}

                {/* Pieces */}
                {pieces.map(piece => (
                  <Piece
                    key={piece.id}
                    piece={piece}
                    scale={scale}
                    isSelected={piece.id === selectedId}
                    onSelect={() => onSelect(piece.id)}
                    onMove={(x, y) => onMove(piece.id, x, y)}
                    onResize={(w, h, x, y) => onResize(piece.id, w, h, x, y)}
                    wallWidth={wallWidth}
                    wallHeight={wallHeight}
                    resizable={false}
                  />
                ))}

                {/* Calibration nudge (uncalibrated + empty) */}
                {!wallImage && pieces.length === 0 && (
                  <div className="wall-empty">
                    <div className="wall-empty-icon">🖼️</div>
                    <p>
                      Click <strong>📐 Calibrate Wall</strong> to correct the photo perspective,
                      then <strong>+ Add Piece</strong> to start placing art.
                    </p>
                    <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={onCalibrate}>
                      📐 Calibrate Wall Now
                    </button>
                    <p className="wall-empty-sub" style={{ marginTop: 6 }}>
                      Wall: {wallWidth}" × {wallHeight}"  ({(wallWidth/12).toFixed(1)}′ × {(wallHeight/12).toFixed(1)}′)
                    </p>
                  </div>
                )}

                {/* Empty state (already calibrated) */}
                {wallImage && pieces.length === 0 && (
                  <div className="wall-empty">
                    <div className="wall-empty-icon">🖼️</div>
                    <p>Click <strong>+ Add Piece</strong> to start placing art on your wall</p>
                    <p className="wall-empty-sub">Wall is {wallWidth}" × {wallHeight}" ({(wallWidth/12).toFixed(1)}′ × {(wallHeight/12).toFixed(1)}′)</p>
                  </div>
                )}

                {/* Dimension label */}
                <div className="wall-dim-label">
                  {wallWidth}" × {wallHeight}"
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
