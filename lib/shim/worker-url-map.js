/* A transport-only adapter. App values and share links stay canonical. */
(function installWorkerUrlMap(g) {
  if (!g || g.__CAD_WORKER_URL_MAP__) return;
  var suffix = '.puter.work';
  function mapped(input, kind) {
    var raw = input && typeof input === 'object' && typeof input.url === 'string' ? input.url : input;
    if (typeof raw !== 'string' && !(raw instanceof URL)) return null;
    var url;
    try { url = new URL(String(raw), g.location.href); } catch (_) { return null; }
    var protocol = url.protocol.toLowerCase();
    if ((kind === 'ws' ? protocol !== 'wss:' && protocol !== 'ws:' : protocol !== 'https:') || url.username || url.password || url.port) return null;
    var host = url.hostname.toLowerCase();
    if (!host.endsWith(suffix) || host.length <= suffix.length) return null;
    var label = host.slice(0, -suffix.length);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
    var page;
    try { page = new URL(g.location.href); } catch (_) { return null; }
    var local = new URL('/w/host/' + label + url.pathname + url.search, page.origin);
    local.protocol = kind === 'ws'
      ? (page.protocol === 'https:' ? 'wss:' : 'ws:')
      : page.protocol;
    return local.href;
  }
  var nativeFetch = g.fetch;
  if (typeof nativeFetch === 'function') {
    g.fetch = function (input, init) {
      var mappedUrl = mapped(input, 'http');
      if (!mappedUrl) return nativeFetch.call(this, input, init);
      var request;
      try {
        request = input instanceof Request ? new Request(input, init) : new Request(input, init);
        return nativeFetch.call(this, new Request(mappedUrl, request));
      } catch (err) {
        return Promise.reject(err);
      }
    };
  }
  var NativeWebSocket = g.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    function MappedWebSocket(url, protocols) {
      var target = mapped(url, 'ws');
      return protocols === undefined ? new NativeWebSocket(target || url) : new NativeWebSocket(target || url, protocols);
    }
    MappedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(MappedWebSocket, NativeWebSocket);
    g.WebSocket = MappedWebSocket;
  }
  var NativeEventSource = g.EventSource;
  if (typeof NativeEventSource === 'function') {
    function MappedEventSource(url, init) {
      var target = mapped(url, 'http');
      return init === undefined ? new NativeEventSource(target || url) : new NativeEventSource(target || url, init);
    }
    MappedEventSource.prototype = NativeEventSource.prototype;
    Object.setPrototypeOf(MappedEventSource, NativeEventSource);
    g.EventSource = MappedEventSource;
  }
  g.__CAD_WORKER_URL_MAP__ = mapped;
})(typeof window !== 'undefined' ? window : globalThis);
