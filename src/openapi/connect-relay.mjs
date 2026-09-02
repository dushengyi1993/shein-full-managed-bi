import http from 'node:http';
import net from 'node:net';

export const SHEIN_OPENAPI_CONNECT_AUTHORITY = 'openapi.sheincorp.com:443';
export const SHEIN_OPENAPI_CONNECT_HOST = 'openapi.sheincorp.com';
export const SHEIN_OPENAPI_CONNECT_PORT = 443;

const FORBIDDEN_RESPONSE = Buffer.from(
  'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
  'ascii',
);
const BAD_GATEWAY_RESPONSE = Buffer.from(
  'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
  'ascii',
);
const CONNECTED_RESPONSE = Buffer.from(
  'HTTP/1.1 200 Connection Established\r\n\r\n',
  'ascii',
);

function closeSocket(socket) {
  if (socket && !socket.destroyed) socket.destroy();
}

function rejectConnect(socket, response = FORBIDDEN_RESPONSE) {
  if (!socket || socket.destroyed) return;
  socket.end(response);
}

export function isAllowedSheinConnectAuthority(authority) {
  return typeof authority === 'string'
    && authority.toLowerCase() === SHEIN_OPENAPI_CONNECT_AUTHORITY;
}

export function createSheinOpenApiConnectRelay({
  dialHost = SHEIN_OPENAPI_CONNECT_HOST,
  dialPort = SHEIN_OPENAPI_CONNECT_PORT,
  connectTimeoutMs = 10_000,
  maxConnections = 64,
  connectImpl = net.connect,
} = {}) {
  if (typeof dialHost !== 'string' || dialHost.trim() === '') {
    throw new TypeError('dialHost must be a non-empty string');
  }
  if (!Number.isSafeInteger(dialPort) || dialPort < 1 || dialPort > 65535) {
    throw new TypeError('dialPort must be an integer from 1 to 65535');
  }
  if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1) {
    throw new TypeError('connectTimeoutMs must be a positive integer');
  }
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 1024) {
    throw new TypeError('maxConnections must be an integer from 1 to 1024');
  }
  if (typeof connectImpl !== 'function') throw new TypeError('connectImpl must be a function');

  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  };

  const server = http.createServer((_request, response) => {
    response.writeHead(405, {
      Allow: 'CONNECT',
      Connection: 'close',
      'Content-Length': '0',
    });
    response.end();
  });
  server.maxConnections = maxConnections;
  server.headersTimeout = connectTimeoutMs;
  server.requestTimeout = connectTimeoutMs;
  server.keepAliveTimeout = 1_000;

  server.on('connect', (request, clientSocket, head) => {
    track(clientSocket);
    if (!isAllowedSheinConnectAuthority(request.url)) {
      rejectConnect(clientSocket);
      return;
    }

    let settled = false;
    let upstream;
    const failUpstream = () => {
      if (settled) return;
      settled = true;
      rejectConnect(clientSocket, BAD_GATEWAY_RESPONSE);
    };
    try {
      upstream = track(connectImpl({ host: dialHost, port: dialPort }));
    } catch {
      failUpstream();
      return;
    }
    upstream.setTimeout(connectTimeoutMs, () => {
      failUpstream();
      closeSocket(upstream);
    });
    upstream.once('connect', () => {
      if (settled) {
        closeSocket(upstream);
        return;
      }
      settled = true;
      upstream.setTimeout(0);
      if (clientSocket.destroyed) {
        closeSocket(upstream);
        return;
      }
      clientSocket.write(CONNECTED_RESPONSE);
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.once('error', () => {
      if (!settled) failUpstream();
      else closeSocket(clientSocket);
    });
    upstream.once('close', () => {
      if (!settled) failUpstream();
    });
    clientSocket.once('close', () => closeSocket(upstream));
  });

  server.on('clientError', (_error, socket) => rejectConnect(socket));

  return {
    server,
    destroySockets() {
      for (const socket of sockets) closeSocket(socket);
    },
  };
}
