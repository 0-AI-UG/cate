// The surface session holds nothing: the pick is a document op
// (`replacePanel`) the view sends, and the host swaps the session.

import { StatelessSession } from '@panels/framework/runtime'

export class SurfaceSession extends StatelessSession {}
