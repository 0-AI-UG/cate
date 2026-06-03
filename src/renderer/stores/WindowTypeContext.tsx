// =============================================================================
// Window Type Context — provides the current window type ('main' | 'dock')
// to child components so they can gate behavior (e.g., drag-out-of-window).
// =============================================================================

import { createContext } from 'react'
import type { CateWindowType } from '../../shared/types'

export const WindowTypeContext = createContext<CateWindowType>('main')
