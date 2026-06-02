declare module 'plantuml-encoder' {
  /** Deflate + PlantUML-base64 encode a diagram source for use in a server URL. */
  export function encode(source: string): string
  /** Inverse of encode. */
  export function decode(encoded: string): string
}
