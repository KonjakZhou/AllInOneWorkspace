import { describe, expect, it } from 'vitest'
import type { Layout } from 'react-grid-layout'
import { alignDisplacedCards } from '../src/workspace/layout'

describe('layout displacement', () => {
  it('aligns the occupied card with the dragged card lower edge', () => {
    const origin: Layout = [
      { i: 'moving', x: 0, y: 12, w: 4, h: 7 },
      { i: 'occupied', x: 0, y: 0, w: 4, h: 7 },
    ]
    const repeatedlyPushed: Layout = [
      { ...origin[0], y: 0 },
      { ...origin[1], y: 38 },
    ]

    expect(alignDisplacedCards(repeatedlyPushed, origin, 'moving')).toEqual([
      { i: 'moving', x: 0, y: 0, w: 4, h: 7 },
      { i: 'occupied', x: 0, y: 7, w: 4, h: 7 },
    ])
  })

  it('keeps the first occupied card aligned and moves a necessary collision below it', () => {
    const origin: Layout = [
      { i: 'moving', x: 0, y: 20, w: 4, h: 8 },
      { i: 'occupied', x: 0, y: 0, w: 4, h: 6 },
      { i: 'below', x: 0, y: 8, w: 4, h: 5 },
      { i: 'side', x: 5, y: 4, w: 4, h: 7 },
    ]
    const current: Layout = [
      { ...origin[0], y: 0 },
      { ...origin[1], y: 40 },
      { ...origin[2], y: 46 },
      { ...origin[3] },
    ]

    const result = alignDisplacedCards(current, origin, 'moving')
    expect(result.find((item) => item.i === 'occupied')?.y).toBe(8)
    expect(result.find((item) => item.i === 'below')?.y).toBe(14)
    expect(result.find((item) => item.i === 'side')?.y).toBe(4)
  })
})
