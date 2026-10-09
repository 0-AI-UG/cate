// workspace/canvas: canvas geometry. Rects, free-slot placement,
// arrangement and snapping. Pure, and imports nothing: the document's canvas
// model (`CanvasModel`, in its schema), its reducer and the client's
// optimistic mirror run it. Each shell draws it in its own UI.

export * from './contract/geometry'
export * from './contract/placement'
export * from './contract/arrange'
export * from './contract/connections'
