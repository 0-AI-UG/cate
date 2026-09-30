// Runs before every test file. Views reach dialogs and settings through
// clientUi(); default to an inert mock. jsdom lacks layout, so give elements
// a zeroed rect and the document an elementFromPoint.

import { installMockClientUi } from '@kernel/ui/testing'

installMockClientUi()

if (typeof window !== 'undefined') {
  if (!HTMLElement.prototype.getBoundingClientRect) {
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() { return {} } } as DOMRect
    }
  }
  if (!document.elementFromPoint) {
    ;(document as Document).elementFromPoint = () => null
  }
}
