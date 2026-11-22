/** Translate the surface registry's logical clip coordinates into native window CSS pixels. */
function scaleClip(clip, scaleX, scaleY) {
  const inset = /^inset\(([-.0-9px ]+)\)$/.exec(clip)
  const number = (value, scale) => Number((Number(value) * scale).toFixed(3))
  if (inset) {
    const [top, right = top, bottom = top, left = right] = inset[1].split(/ +/).map(parseFloat)
    return `inset(${number(top, scaleY)}px ${number(right, scaleX)}px ${number(bottom, scaleY)}px ${number(left, scaleX)}px)`
  }
  const path = /^path\(evenodd, "([^"]+)"\)$/.exec(clip)
  if (!path) return 'none'
  return 'path(evenodd, "' + path[1].replace(/M ([-.\d]+) ([-.\d]+)|([HV]) ([-.\d]+)/g,
    (_, x, y, command, value) => command
      ? `${command} ${number(value, command === 'H' ? scaleX : scaleY)}`
      : `M ${number(x, scaleX)} ${number(y, scaleY)}`) + '")'
}
module.exports = { scaleClip }
