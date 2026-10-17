// A runtime side never imports a client side (caught before R2 too).
import { files } from '../client'
export const bad = files
