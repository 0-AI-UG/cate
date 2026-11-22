let nextIsolatedFixtureSlot = 0;

function bindIsolatedGuest(placeholder, src, partition) {
  const fixture = window.cateIsolatedFixture;
  const slot = ++nextIsolatedFixtureSlot;
  let state = {url: "", title: "", back: false, forward: false, loading: false};
  let zoom = 1;
  let disposed = false;
  let opened = false;
  const invoke = (method, args) => fixture.invoke(method, {slot, args});
  const send = (method, args) => { void invoke(method, args).catch(error => console.error(error)); };
  placeholder.dataset.guestSlot = String(slot);
  const unsubscribe = fixture.onState(({slot: owner, event, state: next, extra}) => {
    if (owner !== slot) return;
    state = next;
    placeholder.dispatchEvent(Object.assign(new Event(event), extra));
  });
  Object.assign(placeholder, {
    getURL: () => state.url,
    getTitle: () => state.title,
    getWebContentsId: () => -slot,
    canGoBack: () => state.back,
    canGoForward: () => state.forward,
    isLoading: () => state.loading,
    insertCSS: css => invoke("css", css),
    loadURL: url => invoke("load", url),
    goBack: () => send("back"),
    goForward: () => send("forward"),
    reload: () => send("reload"),
    reloadIgnoringCache: () => send("reloadIgnoringCache"),
    getZoomFactor: () => zoom,
    setZoomFactor: next => { zoom = next; if (opened) send("zoom", next); },
  });
  let request;
  let last;
  const position = () => {
    if (disposed) return;
    const {x,y,width,height} = placeholder.getBoundingClientRect();
    const logicalWidth = placeholder.offsetWidth;
    const logicalHeight = placeholder.offsetHeight;
    if (!opened && logicalWidth > 0 && logicalHeight > 0) {
      opened = true;
      send("open", {src, width:logicalWidth, height:logicalHeight, partition});
    }
    const surface = placeholder.closest('[data-browser-surface-visible]');
    const box = {x,y,width,height,logicalWidth,logicalHeight,clipPath:surface?.style.clipPath,visible:surface?.dataset.browserSurfaceVisible==='true',inert:surface?.style.pointerEvents==='none'};
    const key = JSON.stringify(box);
    if (opened && key !== last) {
      last = key;
      fixture.place(slot, box);
    }
    request = requestAnimationFrame(position);
  };
  request = requestAnimationFrame(position);
  return () => {
    disposed = true;
    cancelAnimationFrame(request);
    unsubscribe();
    if (opened) send("close");
  };
}
function WebviewSlot({ tabId, src, partition, active, hidden, viewport, displayScale, onElement }) {
  const cleanup = reactExports.useRef();
  const attach = reactExports.useCallback((element) => {
    if (element) cleanup.current = bindIsolatedGuest(element, src, partition);
    else cleanup.current?.();
    onElement(tabId, element);
  }, [onElement, partition, src, tabId]);
  const fixed = viewport.preset !== "compact";
  const frameStyle = fixed ? { width: viewport.width * displayScale, height: viewport.height * displayScale } : { width: "100%", height: "100%" };
  const webviewStyle = fixed ? { width: viewport.width, height: viewport.height } : { width: `${100 / displayScale}%`, height: `${100 / displayScale}%` };
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "div",
    {
      "data-browser-webview-slot": true,
      "data-browser-src": src,
      "data-browser-partition": partition,
      className: `${active ? "relative" : "absolute inset-0 invisible pointer-events-none"} overflow-hidden bg-surface-0`,
      style: frameStyle,
      children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        "div",
        {
          ref: attach,
          tabIndex: 0,
          className: hidden ? "invisible" : "",
          style: {
            ...webviewStyle, display: "inline-flex", maxWidth: "none", objectFit: "fill",
            // Transparent pages need a browser canvas, not Cate's themed surface.
            backgroundColor: "#fff",
            transform: `scale(${displayScale})`,
            transformOrigin: "top left"
          },
          "data-isolated-guest": true
        }
      )
    }
  );
}
