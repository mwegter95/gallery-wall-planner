import { useRef, useState, useEffect, useCallback } from 'react'
import Piece from './Piece'

/** Convert a total-inch measurement to a "X' Y"" label (e.g. 150 → "12' 6\"") */
function fmtFtIn(inches) {
  const ft = Math.floor(inches / 12)
  const i  = Math.round(inches % 12)
  if (i === 0) return `${ft}'`
  return `${ft}' ${i}"`
}

export default function Wall({
  pieces, selectedId, onSelect, onMove, onResize, onDeselect,
  snapToGrid, gridSize, wallWidth, wallHeight,
  wallImage, onCalibrate,
  onUndo, canUndo, onLockToggle, onMoveStart, onResizeStart,
  onStartTutorial, tipsEnabled, onToggleTips, tutorialActive,
  tutorialShowLock,
}) {
  const containerRef = useRef(null)
  const [baseScale, setBaseScale] = useState(5)   // px per inch
  const [zoom, setZoom]           = useState(1.0)
  const [showRulers, setShowRulers] = useState(true)
  const [showGrid,   setShowGrid]   = useState(false)

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

  /* Ruler ticks every 12" (1 foot) + final edge tick if wall isn't an exact # of feet */
  const footTicks = []
  for (let i = 0; i <= wallWidth; i += 12) {
    footTicks.push({ pos: i * scale, label: fmtFtIn(i) })
  }
  // If width isn't an exact foot, add the fractional right-edge tick
  if (wallWidth % 12 !== 0) {
    footTicks.push({ pos: wallWidth * scale, label: fmtFtIn(wallWidth) })
  }
  // Always flip the very last tick's label leftward so it never overflows the ruler
  if (footTicks.length > 0) {
    footTicks[footTicks.length - 1] = { ...footTicks[footTicks.length - 1], isEdge: true }
  }

  // Vertical ruler: top tick = actual wall height, then whole-foot marks up from floor
  const footTicksH = []
  const wholeFeetV  = Math.floor(wallHeight / 12)
  // Top tick: actual wall height in ft+in (e.g. "9' 6"")
  footTicksH.push({ pos: 0, label: fmtFtIn(wallHeight), isEdge: true })
  // Whole-foot marks counting up from the floor (0' at floor, 1', 2', …)
  for (let f = 0; f <= wholeFeetV; f++) {
    const posFromTop = (wallHeight - f * 12) * scale
    if (posFromTop > 0.5) {          // skip if it would overlap the top tick
      footTicksH.push({ pos: posFromTop, label: `${f}'` })
    }
  }

  const handleBgClick = useCallback((e) => {
    if (e.target === e.currentTarget) onDeselect()
  }, [onDeselect])

  /* Currently selected piece object */
  const selectedPiece = pieces.find(p => p.id === selectedId) || null

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
          data-tutorial="ctrl-rulers"
          onClick={() => setShowRulers(r => !r)}
          title="Toggle rulers"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><rect x="1" y="4" width="11" height="5" rx="1" stroke="currentColor" strokeWidth="1.25"/><path d="M3.5 4V5.5M6.5 4V6M9.5 4V5.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>
          Rulers
        </button>
        <button
          className={`ctrl-btn ${showGrid ? 'active' : ''}`}
          data-tutorial="ctrl-grid"
          onClick={() => setShowGrid(g => !g)}
          title="Toggle inch/foot measurement grid"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><path d="M1 4.5h11M1 8.5h11M4.5 1v11M8.5 1v11" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>
          Grid
        </button>
        {snapToGrid && (
          <span className="snap-badge">
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg" style={{display:'inline',verticalAlign:'middle',marginRight:'3px'}}><path d="M1 3.5h9M1 7.5h9M3.5 1v9M7.5 1v9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>
            Snap {gridSize}"
          </span>
        )}

        {/* Lock / Unlock button — shown when a piece is selected, or as a
            disabled placeholder during the lock tutorial step */}
        {(selectedPiece || tutorialShowLock) && (
          <button
            className={`ctrl-btn ctrl-btn--lock ${selectedPiece?.locked ? 'active' : ''} ${!selectedPiece ? 'ctrl-btn--ghost' : ''}`}
            data-tutorial="ctrl-lock"
            onClick={() => selectedPiece && onLockToggle && onLockToggle(selectedId)}
            title={
              !selectedPiece
                ? 'Select a piece on the wall to lock it'
                : selectedPiece.locked ? 'Unlock piece so it can be moved' : 'Lock piece in place'
            }
          >
            {selectedPiece?.locked ? (
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><rect x="2" y="6" width="9" height="6" rx="1" stroke="currentColor" strokeWidth="1.25"/><path d="M4 6V4.5a2.5 2.5 0 015 0V6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/><circle cx="6.5" cy="9" r="1" fill="currentColor"/></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><rect x="2" y="6" width="9" height="6" rx="1" stroke="currentColor" strokeWidth="1.25"/><path d="M4 6V4.5a2.5 2.5 0 015 0" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/><circle cx="6.5" cy="9" r="1" fill="currentColor"/></svg>
            )}
            Lock
          </button>
        )}

        {/* Undo button */}
        <button
          className="ctrl-btn ctrl-btn--undo"
          data-tutorial="ctrl-undo"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo last action (add, move, resize, lock, delete)"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><path d="M2 5.5H8a3.5 3.5 0 010 7H5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/><path d="M4.5 3L2 5.5 4.5 8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>
          Undo
        </button>

        {/* ── Row break on mobile: Tutorial + Tips + piece count move to second row ── */}
        <div className="ctrl-row-break" aria-hidden="true" />

        {/* Tutorial button */}
        <button
          className={`ctrl-btn ctrl-btn--tutorial ${tutorialActive ? 'active' : ''}`}
          data-tutorial="ctrl-tutorial"
          onClick={onStartTutorial}
          title="Start guided tutorial"
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.25"/><path d="M6.5 3.5v.5m0 5V7m0-2.5a1.5 1.5 0 110 3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>
          Tutorial
        </button>

        {/* Tips toggle */}
        <button
          className={`ctrl-btn ctrl-btn--tips ${tipsEnabled ? 'active' : ''}`}
          data-tutorial="ctrl-tips"
          onClick={onToggleTips}
          title={tipsEnabled ? 'Tips are on (click to turn off)' : 'Tips are off (click to turn on)'}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg" className="btn-icon"><path d="M6.5 1.5a3.5 3.5 0 011.5 6.67V9.5h-3V8.17A3.5 3.5 0 016.5 1.5z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round"/><path d="M5 9.5h3M5.5 11h2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/></svg>
          Tips
        </button>

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
                  <div key={t.pos} className={`ruler-tick${t.isEdge ? ' ruler-tick--edge' : ''}`} style={{ left: t.pos }}>
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
                    <div key={t.pos} className={`ruler-tick-v${t.isEdge ? ' ruler-tick--edge' : ''}`} style={{ top: t.pos }}>
                      <span className="ruler-label-v">{t.label}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* The actual wall */}
              <div
                className="wall"
                data-tutorial="wall-area"
                style={{
                  width: wPx,
                  height: hPx,
                  backgroundImage: wallImage ? `url(${wallImage})` : 'none',
                }}
                onClick={handleBgClick}
              >
                {/* Measurement grid overlay (inches + feet) */}
                {showGrid && (
                  <svg
                    className="grid-svg"
                    width={wPx}
                    height={hPx}
                    style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }}
                  >
                    <defs>
                      {/* Vertical offset so grid lines land on whole-foot ruler marks
                          measured from the floor. Without this, the grid tiles from
                          y=0 (top) but the ruler counts up from the floor, so they
                          only align when wallHeight is an exact number of feet.
                          offsetY = (wallHeight mod 12) * scale shifts the pattern
                          so that one tile boundary always falls at the floor (y=hPx). */}
                      {(() => {
                        const offsetY = (wallHeight % 12) * scale
                        return (
                          <>
                            {scale >= 1 && (
                              <pattern id="inch-pat" width={scale} height={scale}
                                patternUnits="userSpaceOnUse"
                                patternTransform={`translate(0,${offsetY})`}>
                                <path
                                  d={`M ${scale} 0 L 0 0 0 ${scale}`}
                                  fill="none"
                                  stroke="rgba(255,255,255,0.09)"
                                  strokeWidth="0.5"
                                />
                              </pattern>
                            )}
                            <pattern id="foot-pat" width={12 * scale} height={12 * scale}
                              patternUnits="userSpaceOnUse"
                              patternTransform={`translate(0,${offsetY})`}>
                              {scale >= 1 && <rect width={12 * scale} height={12 * scale} fill="url(#inch-pat)" />}
                              <path
                                d={`M ${12 * scale} 0 L 0 0 0 ${12 * scale}`}
                                fill="none"
                                stroke="rgba(255,255,255,0.28)"
                                strokeWidth="1"
                              />
                            </pattern>
                          </>
                        )
                      })()}
                    </defs>
                    <rect width="100%" height="100%" fill="url(#foot-pat)" />
                    {/* Foot labels inside the wall */}
                    {Array.from({ length: Math.floor(wallWidth / 12) + 1 }, (_, i) => i).map(fi => (
                      fi > 0 && fi * 12 <= wallWidth && (
                        <text
                          key={`fx-${fi}`}
                          x={fi * 12 * scale + 3}
                          y={10}
                          fill="rgba(255,255,255,0.35)"
                          fontSize={9}
                          fontFamily="ui-monospace,monospace"
                        >{fi}′</text>
                      )
                    ))}
                    {/* Y labels: place fi′ mark at same Y as the vertical ruler tick
                        (wallHeight - fi*12)*scale from top = fi feet up from floor) */}
                    {Array.from({ length: Math.floor(wallHeight / 12) + 1 }, (_, i) => i).map(fi => {
                      const yPos = (wallHeight - fi * 12) * scale
                      return (
                        fi > 0 && yPos > 3 && yPos < hPx && (
                          <text
                            key={`fy-${fi}`}
                            x={4}
                            y={yPos - 3}
                            fill="rgba(255,255,255,0.35)"
                            fontSize={9}
                            fontFamily="ui-monospace,monospace"
                          >{fi}′</text>
                        )
                      )
                    })}
                  </svg>
                )}

                {/* Snap grid overlay */}
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
                    onMoveStart={onMoveStart}
                    onResizeStart={onResizeStart}
                    onLockToggle={onLockToggle}
                  />
                ))}

                {/* Calibration nudge (uncalibrated + empty) */}
                {!wallImage && pieces.length === 0 && (
                  <div className="wall-empty">
                    <div className="wall-empty-icon"><svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.4"/><circle cx="13" cy="17" r="3" stroke="currentColor" strokeWidth="1.5" opacity="0.4"/><path d="M4 27l8-7 6 6 5-5 9 7" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity="0.4"/></svg></div>
                    <p>
                      Click <strong>Calibrate Wall</strong> in the toolbar above to upload a photo
                      and correct the perspective, then add pieces to start arranging your gallery wall.
                    </p>
                    <p className="wall-empty-sub">
                      Wall: {wallWidth}" × {wallHeight}"  ({(wallWidth/12).toFixed(1)}′ × {(wallHeight/12).toFixed(1)}′)
                    </p>
                  </div>
                )}

                {/* Empty state (already calibrated) */}
                {wallImage && pieces.length === 0 && (
                  <div className="wall-empty">
                    <div className="wall-empty-icon"><svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="8" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" opacity="0.4"/><circle cx="13" cy="17" r="3" stroke="currentColor" strokeWidth="1.5" opacity="0.4"/><path d="M4 27l8-7 6 6 5-5 9 7" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" opacity="0.4"/></svg></div>
                    <p>Tap the <strong>+</strong> button in the menu above to add your first piece</p>
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
