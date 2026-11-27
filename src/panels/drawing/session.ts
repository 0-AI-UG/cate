// A drawing has no session state: its strokes are a record field.

import { StatelessSession } from '@panels/framework/runtime'

export class DrawingSession extends StatelessSession {}
