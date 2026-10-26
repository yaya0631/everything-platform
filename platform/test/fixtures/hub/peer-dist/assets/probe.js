/* The peer/events probe page. It exposes small promise helpers on window so
 * the browser E2E can drive the real shim without guessing at app internals. */
(function () {
  var state = {
    log: [],
    ready: false,
    error: null,
    server: null,
    conn: null,
    code: null,
    local: null,
    remoteStream: null,
    sub: null,
  };
  window.__peer = state;

  function add(kind, data) {
    var row = { kind: kind, data: data === undefined ? null : data, at: Date.now() };
    state.log.push(row);
    document.getElementById('log').textContent = JSON.stringify(state.log, null, 2);
  }

  function describeError(err) {
    return { message: String(err && err.message || err), code: err && err.code || null };
  }

  function wire(conn) {
    conn.addEventListener('open', function () { add('open', { connected: conn.connected }); });
    conn.addEventListener('message', function (event) { add('message', event.data); });
    conn.addEventListener('close', function (event) { add('close', event); });
    conn.addEventListener('error', function (event) { add('error', describeError(event.error)); });
    conn.addEventListener('linkstate', function (event) { add('linkstate', event); });
    conn.addEventListener('media', function (event) {
      state.remoteStream = event.stream;
      document.getElementById('remote').srcObject = event.stream;
      add('media', { name: event.name, kind: event.track && event.track.kind, readyState: event.track && event.track.readyState });
    });
    conn.addEventListener('mediaended', function (event) { add('mediaended', { name: event.name }); });
  }

  state.serve = function () {
    return puter.peer.serve().then(function (server) {
      state.server = server;
      state.code = server.inviteCode;
      add('served', { code: server.inviteCode });
      server.addEventListener('connection', function (event) {
        state.conn = event.conn;
        add('connection', { user: event.user });
        wire(event.conn);
      });
      server.addEventListener('close', function (event) { add('server-close', event); });
      return server.inviteCode;
    }).catch(function (err) {
      state.error = describeError(err);
      add('serve-error', state.error);
      throw err;
    });
  };

  state.connect = function (code) {
    return puter.peer.connect(code).then(function (conn) {
      state.conn = conn;
      add('connected', {
        owner: conn.owner,
        connected: conn.connected,
        hasPeerConnection: !!conn.peerconnection,
        hasSend: typeof conn.send === 'function',
      });
      wire(conn);
      return { owner: conn.owner, connected: conn.connected };
    }).catch(function (err) {
      state.error = describeError(err);
      add('connect-error', state.error);
      throw err;
    });
  };

  state.send = function (text) {
    state.conn.send(text);
    add('sent', text);
  };

  state.publish = function (name) {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(function (stream) {
      state.local = stream;
      document.getElementById('camera').srcObject = stream;
      state.conn.publish(name || 'camera', stream, { video: { maxBitrate: 250000 } });
      add('published', {
        name: name || 'camera',
        tracks: stream.getTracks().map(function (track) { return track.kind; }),
      });
      return true;
    });
  };

  state.publishScreen = function () {
    return navigator.mediaDevices.getUserMedia({ video: true }).then(function (stream) {
      state.screen = stream;
      state.conn.publish('screen', stream, {});
      add('published-screen', {
        name: 'screen',
        tracks: stream.getTracks().map(function (track) { return track.kind; }),
      });
      return true;
    });
  };

  state.unpublish = function (name) {
    state.conn.unpublish(name || 'camera');
    add('unpublished', name || 'camera');
  };

  state.closePeer = function (reason) {
    state.conn.close(reason);
    add('closed-locally', reason);
  };

  state.watch = function (subject) {
    return puter.events.onLocal(subject, function (payload) {
      add('event', payload && payload.event);
    }, { includeValue: true }).then(function (sub) {
      state.sub = sub;
      add('subscribed', { subject: sub.subject, subId: sub.subId, match: sub.match });
      return { subject: sub.subject, subId: sub.subId };
    }).catch(function (err) {
      add('subscribe-error', describeError(err));
      throw err;
    });
  };

  state.kvSet = function (key, value) {
    return puter.kv.set(key, value).then(function (result) {
      add('kv-set', { key: key, value: value });
      return result;
    });
  };

  state.ready = true;
  add('ready', { app: window.CAD_HUB_APP || null });
})();
