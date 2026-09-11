export const SHORT_PANEL_ID_LEN = 8

/** The stable panel reference shown by the Cate CLI and accepted by its
 * unique-prefix resolver. */
export function shortPanelId(id: string): string {
  return id.length > SHORT_PANEL_ID_LEN ? id.slice(0, SHORT_PANEL_ID_LEN) : id
}
