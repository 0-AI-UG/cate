// A canvas panel has no session state: its canvas is document data.

import { StatelessSession } from '@panels/framework/runtime'

export class CanvasSession extends StatelessSession {}
