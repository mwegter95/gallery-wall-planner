import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Mobile and warp guard rails', () => {
  it('disables browser zoom gestures via viewport meta', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8')
    expect(html).toMatch(/maximum-scale=1\.0/)
    expect(html).toMatch(/user-scalable=no/)
  })

  it('keeps warp handles in grabbable space', () => {
    const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8')
    expect(css).toMatch(/\.ws-photo-wrap\s*\{[\s\S]*overflow:\s*visible;/)
    expect(css).toMatch(/\.ws-photo-wrap\s*\{[\s\S]*padding:\s*18px;/)
    expect(css).toMatch(/\.ws-photo\s*\{[\s\S]*max-height:\s*calc\(96vh - 240px\);/)
  })
})
