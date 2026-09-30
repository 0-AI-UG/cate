import { registerPanelView } from '@client/host'

registerPanelView('review', () => import('./ReviewView'))

export { openAgentChanges, openReviewPanel, revealPanel, type OpenAgentChangesOptions, type OpenReviewOptions } from '../parts/view/openReview'
