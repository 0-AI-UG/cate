import { KeyedLock } from '../../main/keyedLock'

/** Serializes writes to shared agent configuration files by filename. */
export const agentConfigLock = new KeyedLock()
