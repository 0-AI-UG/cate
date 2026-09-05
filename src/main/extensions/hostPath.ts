import path from 'path'
import { LOCAL_RUNTIME_ID } from '../../shared/runtimeLocator'

/** Join paths using the filesystem syntax of the workspace runtime host. */
export function hostJoin(runtimeId: string, ...segments: string[]): string {
  return (runtimeId === LOCAL_RUNTIME_ID ? path.join : path.posix.join)(...segments)
}
