export interface RecentScreenshot {
  id: string
  filePath: string
  annotated?: boolean
  /** Small thumbnail for the stack and native drag icon. Read filePath for the original image. */
  dataUrl: string
}
