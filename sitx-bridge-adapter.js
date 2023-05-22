module.exports = function(RED) {
  const AUTH_TOKEN_PATH = "/api/v1/client_auth/token";
  const request = require('request');
  const WebSocket = require('ws');

  let node = null;
  let accessToken = null;
  let authDomain = null;
  let resource = null;
  let subdomain = null;
  let ws = null;

  function SitXBridgeAdapterNode(config) {
    RED.nodes.createNode(this, config);
    node = this;

    node.on('input', function(msg) {
      //node.send(msg);
      if (node.server) {
        node.server.send(msg.payload);
      }
    });

    node.on("close", function(done) {
      if (node.heartbeatInterval) {
        clearInterval(node.heartbeatInterval);
      }
      node.closing = true;
      if (node.server) {
        node.server.close();
      }
      //wait 20*50 (1000ms max) for ws to close.
      //call done when readyState === ws.CLOSED (or 1000ms, whichever comes fist)
      const closeMonitorInterval = 20;
      let closeMonitorCount = 50;
      let si = setInterval(() => {
        if (node.server == null || node.server.readyState === WebSocket.CLOSED || closeMonitorCount <= 0) {
          if (node.tout) {
            clearTimeout(node.tout);
            node.tout = null;
          }
          clearInterval(si);
          return done();
        }
        closeMonitorCount--;
      }, closeMonitorInterval);
    });
    node.on('nrSocketOpened', function(event) {
      node.status({
        fill:"green",
        shape:"dot",
        text:"connected",
        event:"connect"
      });
    });
    node.on("nrSocketError", function(event) {
      node.status({
        fill:"red",shape:"ring",text:"common.status.error", event:"error"
      });
    });
    node.on('nrSocketClosed', function(event) {
      var status;
      status = {fill:"red",shape:"ring",text:"common.status.disconnected"};
      status.event = "disconnect";
      node.status(status);
    });
    authDomain = config.resource_uri.split(".").slice(2).join(".").split("/")[0];
    resource = config.resource_uri.split("/")[config.resource_uri.split("/").length - 1];
    subdomain = config.resource_uri.split(".")[0];

    function startBridge() {
      acquireAuthToken(config, function(err, authToken) {
        if (err) {
          return localErrorHandler(err);
        }
        startSocket(config, authToken);
      });
    }

    function acquireAuthToken(config, callback) {
      const authUrl = `${subdomain}.${authDomain}${AUTH_TOKEN_PATH}`;
      const scope = config.resource_uri + config.scope;
      node.log("scope: " + scope);
      const form = { grant_type: "client_credentials",
                     client_id: config.access_key_id,
                     client_secret: config.secret_key,
                     scope: scope };
      const headers = {"content-type" : "application/x-www-form-urlencoded"};
      const options = {
        url: authUrl,
        headers: headers,
        form: form,
        json: true
      };

      request.post(options,
        function(err, response, body) {
          if (err || body['error']) {
            node.log("Unable to acquire the SitXBridgeAdapter token.");
            node.log(err || body['error']);
            return callback(err || body['error']);
          } else {
            accessToken = body['access_token'];
            return callback(null, accessToken);
          };
        }
      );
    }
    function localErrorHandler(err) {
      clearInterval(node.heartbeatInterval);
        node.emit('nrSocketError',{err:err});
        if (!node.closing && !node.isServer) {
          clearTimeout(node.tout);
          node.tout = setTimeout(function() { startBridge(); }, 3000); // try to reconnect every 3 secs... bit fast ?
        }
    }
    function startSocket(config, authToken) {
      let authHeader = `Bearer ${authToken}`;
      let socketUrl = config.resource_uri.replace(/https/, 'wss');
      socketUrl = config.resource_uri.replace(/http/, 'ws');
      const socket = new WebSocket(socketUrl, [], { 'headers': { 'Authorization': authHeader } } );

      var id = RED.util.generateId();
      socket.nrId = id;
      socket.nrPendingHeartbeat = false;
      socket.on('open', function connect(){
        if (node.heartbeat) {
          clearInterval(node.heartbeatInterval);
          node.heartbeatInterval = setInterval(function() {
            if (socket.nrPendingHeartbeat) {
              // No pong received
              socket.terminate();
              socket.nrErrorHandler(new Error("timeout"));
              return;
            }
            socket.nrPendingHeartbeat = true;
            try {
              socket.ping();
            } catch(err) {}
          },node.heartbeat);
        }
        node.emit('nrSocketOpened');
      });
      socket.on('message', (msg) => handleMessage(msg));
      function handleMessage(msg) {
        const msgToSend = {
          payload: msg.toString(),
          websocket: socket.send.bind(socket)
        };
        node.send(msgToSend);
      }
      socket.on('error', localErrorHandler);
      socket.on('close', function close(){
        clearInterval(node.heartbeatInterval);
        node.emit('nrSocketClosed');
        if (!node.closing) {
          clearTimeout(node.tout);
          node.log('SitX Bridge connection has been closed! Retrying...');
          node.tout = setTimeout(function() { startBridge(); }, 3000);
        }
      });
      socket.on('ping', function() {
        socket.nrPendingHeartbeat = false;
      })
      socket.on('pong', function() {
        socket.nrPendingHeartbeat = false;
      })
      // hold ref for node closing interaction
      node.server = socket;
    }
    node.closing = false;
    startBridge();
  }
  RED.nodes.registerType("sitx-bridge-adapter both", SitXBridgeAdapterNode);
  RED.nodes.registerType("sitx-bridge-adapter in", SitXBridgeAdapterNode);
  RED.nodes.registerType("sitx-bridge-adapter out", SitXBridgeAdapterNode);
}
