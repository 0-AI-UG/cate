import { registerPanelView } from '../../client/host/views'

registerPanelView('review', () => import('./ReviewView'))

export { openAgentChanges, openReviewPanel, revealPanel, type OpenAgentChangesOptions, type OpenReviewOptions } from './parts/openReview'
