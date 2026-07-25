// =============================================================================
// guestScripts — the JavaScript the browser driver injects into a guest page.
//
// Everything here returns a SOURCE STRING for webview.executeJavaScript. Two
// rules hold for every builder in this file:
//
//  1. Caller-supplied values (refs, selectors, text) are NEVER interpolated into
//     the source. They are passed as arguments via JSON.stringify, so a value
//     containing quotes or `</script>` is data, not code.
//  2. Layout reads and DOM writes are kept in separate passes. A write
//     invalidates layout, so interleaving them forces one synchronous reflow per
//     element — O(n) reflows on a page with thousands of nodes.
//
// Refs are generation-scoped tokens (`@s3e17`): `s3` is the snapshot generation,
// `e17` the element within it. A ref from an older generation cannot silently
// address a different element after the page re-renders — it resolves to
// nothing, and the driver reports `stale-ref` instead of clicking the wrong
// thing. `snapshot` starts a new generation (and clears old tags); `find` adds
// tags WITHIN the current generation, so refs from a snapshot and a subsequent
// find remain usable together.
// =============================================================================

/** Selector for elements a snapshot considers interactive or structural. */
const SNAPSHOT_SELECTOR =
  'a[href],button,input,textarea,select,[role],[contenteditable],[onclick],summary,h1,h2,h3,h4,h5,h6'

/** Shared preamble: element lookup by ref, without building a CSS selector out
 *  of caller input (compare attributes instead — no injection surface). */
const ELEMENT_BY_REF = `var el = null
  var all = document.querySelectorAll('[data-cate-ref]')
  for (var i = 0; i < all.length; i++) { if (all[i].getAttribute('data-cate-ref') === ref) { el = all[i]; break } }`

/** Shared preamble: describe one element as a snapshot row. Expects `el` and
 *  `ref` in scope, leaves the row in `item`. */
const DESCRIBE_ELEMENT = `var role = el.getAttribute('role') || el.tagName.toLowerCase()
  if (role === 'input') role = 'input:' + (el.type || 'text').toLowerCase()
  var name = el.getAttribute('aria-label') || ''
  if (!name && el.labels && el.labels.length) name = el.labels[0].textContent || ''
  if (!name && el.tagName !== 'SELECT') name = el.textContent || ''
  if (!name) name = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('value') || ''
  name = name.replace(/[\\s\\u00a0]+/g, ' ').trim().slice(0, 200)
  var value = 'value' in el ? el.value : undefined
  if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password') {
    value = value ? '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022' : ''
  }
  var inputType = el.tagName === 'INPUT' ? String(el.type).toLowerCase() : ''
  var checked = inputType === 'checkbox' || inputType === 'radio' ? Boolean(el.checked) : undefined
  var expandedAttr = el.getAttribute('aria-expanded')
  var selectedAttr = el.getAttribute('aria-selected')
  var item = { ref: ref, role: role, name: name, value: value }
  if (Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true') item.disabled = true
  if (checked !== undefined) item.checked = checked
  if (expandedAttr !== null) item.expanded = expandedAttr === 'true'
  if (selectedAttr !== null) item.selected = selectedAttr === 'true'
  if (document.activeElement === el) item.focused = true`

/** Shared preamble: is `el` rendered? Leaves a boolean in `elVisible`. */
const IS_VISIBLE = `var elRect = el.getBoundingClientRect()
  var elStyle = getComputedStyle(el)
  var elVisible = elRect.width > 0 && elRect.height > 0 &&
    elStyle.visibility !== 'hidden' && elStyle.display !== 'none' && elStyle.opacity !== '0'`

// -----------------------------------------------------------------------------
// Snapshot
// -----------------------------------------------------------------------------

/** Full accessibility-ish snapshot. `scopeSelector` limits it to a subtree (the
 *  agent-facing `--selector` flag); `max` caps the row count so a huge page
 *  cannot blow the reply size (0 = unlimited). */
export function snapshotJs(snapshotId: string, scopeSelector?: string, max = 0): string {
  return `(function (snapshotId, scopeSelector, max, sel) {
  document.querySelectorAll('[data-cate-ref]').forEach(function (el) { el.removeAttribute('data-cate-ref') })
  var root = document
  if (scopeSelector) {
    try { root = document.querySelector(scopeSelector) } catch (e) { return { error: 'bad-selector' } }
    if (!root) return { error: 'no-such-element' }
  }
  // Pass 1 — reads only: keep the visible matches in document order.
  var visible = []
  Array.prototype.forEach.call(root.querySelectorAll(sel), function (el) {
    var rect = el.getBoundingClientRect()
    var style = getComputedStyle(el)
    if (rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden' || style.display === 'none') return
    visible.push(el)
  })
  var truncated = false
  if (max > 0 && visible.length > max) { visible = visible.slice(0, max); truncated = true }
  // Pass 2 — writes + output; no layout reads past this point.
  var refs = []
  for (var i = 0; i < visible.length; i++) {
    var el = visible[i]
    var ref = '@' + snapshotId + 'e' + (i + 1)
    el.setAttribute('data-cate-ref', ref)
    ${DESCRIBE_ELEMENT}
    refs.push(item)
  }
  return {
    snapshotId: snapshotId,
    url: location.href,
    title: document.title,
    refs: refs,
    truncated: truncated,
    nextIndex: refs.length,
  }
})(${JSON.stringify(snapshotId)}, ${JSON.stringify(scopeSelector ?? '')}, ${JSON.stringify(max)}, ${JSON.stringify(SNAPSHOT_SELECTOR)})`
}

// -----------------------------------------------------------------------------
// Locators — Codex's getByRole / getByText / getByLabel / getByPlaceholder /
// getByTestId / locator(css), expressed as one query with a `by` discriminator.
// -----------------------------------------------------------------------------

export type LocatorBy = 'role' | 'text' | 'label' | 'placeholder' | 'testid' | 'css' | 'altText' | 'title'

export interface LocatorQuery {
  by: LocatorBy
  value: string
  /** Restrict to the nth match (0-based). Absent = every match. */
  nth?: number
  /** Substring match (default) vs whole-string equality. */
  exact?: boolean
}

/** Tag matches with refs in the CURRENT generation and describe them. Unlike a
 *  snapshot this does not clear existing tags, so refs already handed out stay
 *  valid. `startIndex` continues the element numbering within the generation. */
export function locateJs(snapshotId: string, query: LocatorQuery, startIndex: number): string {
  return `(function (snapshotId, query, startIndex) {
  var out = []
  var candidates = []
  var norm = function (s) { return (s || '').replace(/[\\s\\u00a0]+/g, ' ').trim() }
  var matches = function (haystack) {
    var h = norm(haystack).toLowerCase()
    var needle = norm(query.value).toLowerCase()
    return query.exact ? h === needle : h.indexOf(needle) !== -1
  }
  if (query.by === 'css') {
    try { candidates = Array.prototype.slice.call(document.querySelectorAll(query.value)) }
    catch (e) { return { error: 'bad-selector' } }
  } else if (query.by === 'testid') {
    try {
      candidates = Array.prototype.slice.call(
        document.querySelectorAll('[data-testid],[data-test-id],[data-test]'),
      ).filter(function (el) {
        return matches(el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test'))
      })
    } catch (e) { return { error: 'bad-selector' } }
  } else {
    var all = Array.prototype.slice.call(document.querySelectorAll('*'))
    candidates = all.filter(function (el) {
      if (query.by === 'role') {
        var role = el.getAttribute('role') || el.tagName.toLowerCase()
        if (!matches(role)) return false
        return true
      }
      if (query.by === 'placeholder') return matches(el.getAttribute('placeholder'))
      if (query.by === 'altText') return matches(el.getAttribute('alt'))
      if (query.by === 'title') return matches(el.getAttribute('title'))
      if (query.by === 'label') {
        if (matches(el.getAttribute('aria-label'))) return true
        if (el.labels && el.labels.length) {
          for (var i = 0; i < el.labels.length; i++) { if (matches(el.labels[i].textContent)) return true }
        }
        return false
      }
      // text: only the element that most tightly wraps the text — otherwise
      // every ancestor up to <body> "contains" it and the result is useless.
      if (!matches(el.textContent)) return false
      for (var c = 0; c < el.children.length; c++) {
        if (matches(el.children[c].textContent)) return false
      }
      return true
    })
  }
  // Visible matches only, in document order (reads first — no writes yet).
  var visible = candidates.filter(function (el) {
    var rect = el.getBoundingClientRect()
    var style = getComputedStyle(el)
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  })
  if (typeof query.nth === 'number') {
    visible = visible[query.nth] ? [visible[query.nth]] : []
  }
  for (var j = 0; j < visible.length; j++) {
    var el = visible[j]
    // Reuse an existing tag so repeat finds are stable within a generation.
    var ref = el.getAttribute('data-cate-ref')
    if (!ref || ref.indexOf('@' + snapshotId + 'e') !== 0) {
      ref = '@' + snapshotId + 'e' + (startIndex + j + 1)
      el.setAttribute('data-cate-ref', ref)
    }
    ${DESCRIBE_ELEMENT}
    out.push(item)
  }
  return { snapshotId: snapshotId, url: location.href, title: document.title, refs: out, nextIndex: startIndex + out.length }
})(${JSON.stringify(snapshotId)}, ${JSON.stringify(query)}, ${JSON.stringify(startIndex)})`
}

// -----------------------------------------------------------------------------
// Actionability + focus
// -----------------------------------------------------------------------------

export type ActionMode = 'click' | 'fill' | 'select' | 'check' | 'hover'

/** Resolve a ref to a stable, hit-testable point. Returns the click point plus
 *  the element box (the driver forwards it to the cursor overlay so the user
 *  sees WHAT is being acted on, not just where). */
export function actionabilityJs(ref: string, mode: ActionMode): string {
  return `(function (ref, mode) {
  ${ELEMENT_BY_REF}
  if (!el) return { error: 'stale-ref' }
  if (!el.isConnected) return { error: 'detached' }
  el.scrollIntoView({ block: 'center', inline: 'center' })
  ${IS_VISIBLE}
  if (!elVisible) return { error: 'not-visible' }
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { error: 'disabled' }
  if (mode === 'fill') {
    var editable = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
    if (!editable) return { error: 'not-editable' }
    if (el.readOnly || el.getAttribute('aria-readonly') === 'true') return { error: 'readonly' }
  }
  if (mode === 'select' && el.tagName !== 'SELECT') return { error: 'not-a-select' }
  if (mode === 'check') {
    var type = el.tagName === 'INPUT' ? String(el.type).toLowerCase() : ''
    var roleAttr = el.getAttribute('role')
    if (type !== 'checkbox' && type !== 'radio' && roleAttr !== 'checkbox' && roleAttr !== 'switch') {
      return { error: 'not-checkable' }
    }
  }
  var x = Math.max(0, Math.floor(elRect.left + elRect.width / 2))
  var y = Math.max(0, Math.floor(elRect.top + elRect.height / 2))
  var hit = document.elementFromPoint ? document.elementFromPoint(x, y) : el
  if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) return { error: 'obscured' }
  return {
    ok: true,
    x: x,
    y: y,
    box: [Math.floor(elRect.left), Math.floor(elRect.top), Math.floor(elRect.width), Math.floor(elRect.height)],
    rect: [elRect.left, elRect.top, elRect.width, elRect.height].join(':'),
    name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').replace(/[\\s\\u00a0]+/g, ' ').trim().slice(0, 60),
  }
})(${JSON.stringify(ref)}, ${JSON.stringify(mode)})`
}

export function focusJs(ref: string): string {
  return `(function (ref) {
  ${ELEMENT_BY_REF}
  if (!el) return { error: 'stale-ref' }
  el.scrollIntoView({ block: 'center' })
  el.focus()
  return { ok: true }
})(${JSON.stringify(ref)})`
}

/** Focus AND select existing content, so the subsequent keystrokes replace it
 *  (fill semantics) rather than appending to it (type semantics). */
export function focusForFillJs(ref: string): string {
  return `(function (ref) {
  ${ELEMENT_BY_REF}
  if (!el) return { error: 'stale-ref' }
  el.scrollIntoView({ block: 'center' })
  el.focus()
  if (typeof el.select === 'function') {
    el.select()
  } else if (el.isContentEditable) {
    var selection = getSelection()
    var range = document.createRange()
    range.selectNodeContents(el)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return { ok: true }
})(${JSON.stringify(ref)})`
}

/** Move the caret to the end without selecting — `type` appends. */
export function focusForTypeJs(ref: string): string {
  return `(function (ref) {
  ${ELEMENT_BY_REF}
  if (!el) return { error: 'stale-ref' }
  el.scrollIntoView({ block: 'center' })
  el.focus()
  if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
    try { el.setSelectionRange(el.value.length, el.value.length) } catch (e) { /* type=email etc. */ }
  } else if (el.isContentEditable) {
    var selection = getSelection()
    var range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return { ok: true }
})(${JSON.stringify(ref)})`
}

// -----------------------------------------------------------------------------
// Inspection
// -----------------------------------------------------------------------------

/** Visible text of an element, or of the page when `ref` is empty. */
export function textJs(ref: string, max: number): string {
  return `(function (ref, max) {
  var target = document.body
  if (ref) {
    ${ELEMENT_BY_REF}
    if (!el) return { error: 'stale-ref' }
    target = el
  }
  if (!target) return { error: 'no-document' }
  var text = target.innerText || target.textContent || ''
  var truncated = max > 0 && text.length > max
  return { text: truncated ? text.slice(0, max) : text, truncated: truncated }
})(${JSON.stringify(ref)}, ${JSON.stringify(max)})`
}

export function attributesJs(ref: string): string {
  return `(function (ref) {
  ${ELEMENT_BY_REF}
  if (!el) return { error: 'stale-ref' }
  var attrs = {}
  for (var i = 0; i < el.attributes.length; i++) {
    var attr = el.attributes[i]
    attrs[attr.name] = attr.value
  }
  if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password' && attrs.value) {
    attrs.value = '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022'
  }
  return { tag: el.tagName.toLowerCase(), attributes: attrs }
})(${JSON.stringify(ref)})`
}

/** Interaction-relevant state of one element: what Codex's isVisible /
 *  isEnabled / isChecked / boundingBox report, in a single round trip. */
export function stateJs(ref: string): string {
  return `(function (ref) {
  ${ELEMENT_BY_REF}
  if (!el) return { error: 'stale-ref' }
  ${IS_VISIBLE}
  var type = el.tagName === 'INPUT' ? String(el.type).toLowerCase() : ''
  var value = 'value' in el ? el.value : undefined
  if (type === 'password' && value) value = '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022'
  return {
    ref: ref,
    tag: el.tagName.toLowerCase(),
    visible: elVisible,
    attached: el.isConnected,
    enabled: !(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    focused: document.activeElement === el,
    checked: (type === 'checkbox' || type === 'radio') ? Boolean(el.checked) : undefined,
    value: value,
    box: [Math.floor(elRect.left), Math.floor(elRect.top), Math.floor(elRect.width), Math.floor(elRect.height)],
  }
})(${JSON.stringify(ref)})`
}

/** Page-level metadata + the links/images/scripts an agent might want to fetch
 *  directly (Codex's "collecting page assets"). */
export function assetsJs(max: number): string {
  return `(function (max) {
  var take = function (nodes, map) {
    var out = []
    for (var i = 0; i < nodes.length && (max <= 0 || out.length < max); i++) {
      var v = map(nodes[i])
      if (v && v.url) out.push(v)
    }
    return out
  }
  return {
    url: location.href,
    title: document.title,
    links: take(document.querySelectorAll('a[href]'), function (a) {
      return { url: a.href, text: (a.textContent || '').replace(/[\\s\\u00a0]+/g, ' ').trim().slice(0, 120) }
    }),
    images: take(document.querySelectorAll('img[src]'), function (img) {
      return { url: img.currentSrc || img.src, alt: img.getAttribute('alt') || '' }
    }),
    scripts: take(document.querySelectorAll('script[src]'), function (s) { return { url: s.src } }),
    stylesheets: take(document.querySelectorAll('link[rel~="stylesheet"][href]'), function (l) { return { url: l.href } }),
  }
})(${JSON.stringify(max)})`
}

// -----------------------------------------------------------------------------
// Mutating helpers that must run in-page (no input event can express them)
// -----------------------------------------------------------------------------

/** <select> option choice. Matches by value, then by visible label, so callers
 *  can say what they see. Fires input+change like a real user selection. */
export function selectOptionJs(ref: string, values: string[]): string {
  return `(function (ref, values) {
  ${ELEMENT_BY_REF}
  if (!el) return { error: 'stale-ref' }
  if (el.tagName !== 'SELECT') return { error: 'not-a-select' }
  var wanted = values.slice()
  var chosen = []
  for (var i = 0; i < el.options.length; i++) {
    var opt = el.options[i]
    var label = (opt.textContent || '').replace(/[\\s\\u00a0]+/g, ' ').trim()
    var hit = wanted.indexOf(opt.value) !== -1 || wanted.indexOf(label) !== -1
    // A multi-select takes the given list as the WHOLE selection (deselecting
    // anything not named); a single select just moves to the matching option.
    if (el.multiple) opt.selected = hit
    else if (hit) el.value = opt.value
    if (hit) chosen.push({ value: opt.value, label: label })
  }
  if (!chosen.length) return { error: 'no-matching-option' }
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, selected: chosen }
})(${JSON.stringify(ref)}, ${JSON.stringify(values)})`
}

/** Report a checkbox/radio's state so the driver can decide whether a real
 *  click is needed — check/uncheck are idempotent, unlike a raw click. */
export function checkedStateJs(ref: string): string {
  return `(function (ref) {
  ${ELEMENT_BY_REF}
  if (!el) return { error: 'stale-ref' }
  var type = el.tagName === 'INPUT' ? String(el.type).toLowerCase() : ''
  var checked = (type === 'checkbox' || type === 'radio')
    ? Boolean(el.checked)
    : el.getAttribute('aria-checked') === 'true'
  return { checked: checked }
})(${JSON.stringify(ref)})`
}

/** Scroll the page (or one element) by a delta, or to an edge. Used when no
 *  wheel target makes sense — `scroll --to bottom` on a scroll container. */
export function scrollJs(ref: string, dx: number, dy: number, to?: 'top' | 'bottom'): string {
  return `(function (ref, dx, dy, to) {
  var target = document.scrollingElement || document.documentElement
  if (ref) {
    ${ELEMENT_BY_REF}
    if (!el) return { error: 'stale-ref' }
    target = el
  }
  if (to === 'top') target.scrollTop = 0
  else if (to === 'bottom') target.scrollTop = target.scrollHeight
  else { target.scrollLeft += dx; target.scrollTop += dy }
  return { ok: true, scrollTop: target.scrollTop, scrollLeft: target.scrollLeft, scrollHeight: target.scrollHeight }
})(${JSON.stringify(ref)}, ${JSON.stringify(dx)}, ${JSON.stringify(dy)}, ${JSON.stringify(to ?? '')})`
}

// -----------------------------------------------------------------------------
// Dialogs
// -----------------------------------------------------------------------------

/** Install auto-responders for alert/confirm/prompt and record what was asked.
 *
 *  Chromium handles guest JS dialogs itself and Electron exposes no <webview>
 *  event for them, so the only way an agent can get past (or even SEE) a dialog
 *  is to replace the functions in the page. That means this only covers dialogs
 *  raised AFTER it is installed, in the CURRENT document — the driver reinstalls
 *  it after navigation, and `browser dialogs` reports what has been captured. */
export function installDialogHandlerJs(policy: 'accept' | 'dismiss', promptText: string): string {
  return `(function (policy, promptText) {
  var store = window.__cateDialogs
  if (!store) {
    store = window.__cateDialogs = { log: [], policy: policy, promptText: promptText }
    var record = function (type, message, result) {
      store.log.push({ type: type, message: String(message == null ? '' : message).slice(0, 500), result: result, at: Date.now() })
      if (store.log.length > 20) store.log.shift()
    }
    window.alert = function (message) { record('alert', message, true); return undefined }
    window.confirm = function (message) {
      var accepted = store.policy === 'accept'
      record('confirm', message, accepted)
      return accepted
    }
    window.prompt = function (message, def) {
      var accepted = store.policy === 'accept'
      var value = accepted ? (store.promptText || def || '') : null
      record('prompt', message, value)
      return value
    }
  }
  store.policy = policy
  store.promptText = promptText
  return { ok: true, policy: store.policy }
})(${JSON.stringify(policy)}, ${JSON.stringify(promptText)})`
}

export function readDialogsJs(): string {
  return `(function () {
  var store = window.__cateDialogs
  return { installed: Boolean(store), policy: store ? store.policy : null, dialogs: store ? store.log : [] }
})()`
}

// -----------------------------------------------------------------------------
// Waiting
// -----------------------------------------------------------------------------

export type WaitCondition =
  | { kind: 'load' }
  | { kind: 'text' | 'textGone' | 'url'; value: string }
  | { kind: 'ref'; ref: string; state: 'visible' | 'hidden' | 'attached' | 'detached' }
  | { kind: 'selector'; value: string; state: 'visible' | 'hidden' | 'attached' | 'detached' }

export function waitConditionJs(condition: Exclude<WaitCondition, { kind: 'load' }>): string {
  return `(function (condition) {
    if (condition.kind === 'text' || condition.kind === 'textGone') {
      var text = document.body ? (document.body.innerText || document.body.textContent || '') : ''
      var found = text.indexOf(condition.value) !== -1
      return condition.kind === 'text' ? found : !found
    }
    if (condition.kind === 'url') {
      var escaped = condition.value.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\$&').split('*').join('.*')
      return new RegExp('^' + escaped + '$').test(location.href)
    }
    var target = null
    if (condition.kind === 'selector') {
      try { target = document.querySelector(condition.value) } catch (e) { return false }
    } else {
      var nodes = document.querySelectorAll('[data-cate-ref]')
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('data-cate-ref') === condition.ref) { target = nodes[i]; break }
      }
    }
    var attached = Boolean(target && target.isConnected)
    var visible = false
    if (attached) {
      var rect = target.getBoundingClientRect()
      var style = getComputedStyle(target)
      visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    if (condition.state === 'attached') return attached
    if (condition.state === 'detached') return !attached
    if (condition.state === 'visible') return visible
    return !visible
  })(${JSON.stringify(condition)})`
}
