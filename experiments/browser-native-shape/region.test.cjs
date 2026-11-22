const assert = require('node:assert/strict')
const { test } = require('node:test')
const { shapeForBounds } = require('./region.cjs')

const outer = { left: 0, top: 0, right: 16, bottom: 12 }

test('fully occluded and inactive windows return a hidden state', () => {
  assert.deepEqual(shapeForBounds(true, outer, [outer]), { visible:false, rectangles:[] })
  assert.deepEqual(shapeForBounds(false, outer, []), { visible:false, rectangles:[] })
  assert.deepEqual(shapeForBounds(true, outer, []), {
    visible:true, rectangles:[{ x:0, y:0, width:16, height:12 }],
  })
})

test('native region covers only visible pixels with overlap and fractional edges', () => {
  const bounds = { left: .2, top: 1.8, right: 15.6, bottom: 12 }
  const holes = [
    { left: -3, top: 2, right: 4.2, bottom: 9.1 },
    { left: 3.5, top: 4.7, right: 10, bottom: 7.3 },
    { left: 8, top: 7.9, right: 19, bottom: 11 },
    { left: 11, top: 3, right: 11, bottom: 7 },
  ]
  const intersects = (hole, x, y) => hole.left < hole.right && hole.top < hole.bottom &&
    hole.left < x + 1 && hole.right > x && hole.top < y + 1 && hole.bottom > y
  for (const occluders of [holes, holes.toReversed()]) {
    const result = shapeForBounds(true, bounds, occluders)
    assert.equal(result.visible, true)
    for (let y = 0; y < 13; y++) for (let x = 0; x < 17; x++) {
      const inside = x >= bounds.left && x + 1 <= bounds.right && y >= bounds.top && y + 1 <= bounds.bottom
      const count = result.rectangles.filter(r => x >= r.x && x < r.x+r.width && y >= r.y && y < r.y+r.height).length
      assert.equal(count, Number(inside && !holes.some(hole => intersects(hole, x, y))), [x,y].join(','))
    }
  }
})
