// The daemon's lifecycle bus is made by its entry (`createLifecycleBus`) and
// handed to the rpc server, which emits client presence on it; the entry
// emits shutdown. There is no process-wide instance.

export { createLifecycleBus, type ClientConnection, type LifecycleBus } from '../contract'
