import type { Layout, LayoutItem } from 'react-grid-layout'

function overlaps(a: LayoutItem, b: LayoutItem) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function alignDisplacedCards(current: Layout, origin: Layout, movingId: string): Layout {
  const moving = current.find((item) => item.i === movingId)
  if (!moving || !origin.some((item) => item.i === movingId))
    return current.map((item) => ({ ...item }))

  const placed: LayoutItem[] = [{ ...moving }]
  const resolved = new Map<string, LayoutItem>([[movingId, placed[0]]])
  const remaining = origin
    .filter((item) => item.i !== movingId)
    .map((item, index) => ({ item: { ...item }, index }))
    .sort((a, b) => a.item.y - b.item.y || a.item.x - b.item.x || a.index - b.index)

  for (const entry of remaining) {
    const item = entry.item
    for (;;) {
      const collisions = placed.filter((other) => overlaps(item, other))
      if (!collisions.length) break
      item.y = Math.max(...collisions.map((other) => other.y + other.h))
    }
    placed.push(item)
    resolved.set(item.i, item)
  }

  return current.map((item) => {
    const position = resolved.get(item.i)
    return position
      ? { ...item, x: position.x, y: position.y, w: position.w, h: position.h }
      : { ...item }
  })
}
