// Regions use integer window coordinates. Round the visible bounds inward and
// exclusions outward so a window never claims input over a clipped edge.
function shapeForBounds(visible, outer, occluders) {
  if (!visible) return { visible: false, rectangles: [] }
  const bounds = {
    left: Math.ceil(outer.left), right: Math.floor(outer.right),
    top: Math.ceil(outer.top), bottom: Math.floor(outer.bottom),
  }
  const positive = rect => rect.right > rect.left && rect.bottom > rect.top
  let rectangles = positive(bounds) ? [bounds] : []
  for (const {left, right, top, bottom} of occluders) {
    if (left >= right || top >= bottom) continue
    const hole = {left: Math.floor(left), right: Math.ceil(right), top: Math.floor(top), bottom: Math.ceil(bottom)}
    rectangles = rectangles.flatMap(rect => {
      const intersection = {
        left: Math.max(rect.left, hole.left), right: Math.min(rect.right, hole.right),
        top: Math.max(rect.top, hole.top), bottom: Math.min(rect.bottom, hole.bottom),
      }
      if (!positive(intersection)) return [rect]
      return [
        {...rect, bottom: intersection.top},
        {...rect, top: intersection.bottom},
        {...intersection, left: rect.left, right: intersection.left},
        {...intersection, left: intersection.right, right: rect.right},
      ].filter(positive)
    })
  }
  // Electron resets a shape when it receives []. The caller must hide a fully
  // occluded window instead of passing an empty array to BrowserWindow.setShape.
  return {
    visible: rectangles.length > 0,
    rectangles: rectangles.map(({left, right, top, bottom}) =>
      ({ x: left, y: top, width: right - left, height: bottom - top })),
  }
}
module.exports = {shapeForBounds}
