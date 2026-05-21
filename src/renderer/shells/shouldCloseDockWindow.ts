export function shouldCloseDockWindow(args: { isDockEmpty: boolean; hasEverHadPanels: boolean }): boolean {
  return args.isDockEmpty && args.hasEverHadPanels
}
