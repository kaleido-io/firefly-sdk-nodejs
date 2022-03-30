import { IncomingMessage } from 'http';
import { Transform } from 'stream';
import * as WebSocket from 'ws';
import { FireFlyEvent, FireFlyWebSocketOptions } from './interfaces';

export interface FireFlyWebSocketCallback {
  (socket: FireFlyWebSocket, data: FireFlyEvent): void;
}

export class FireFlyWebSocket {
  private socket?: WebSocket;
  private closed = false;
  private pingTimer?: NodeJS.Timeout;
  private disconnectTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private disconnectDetected = false;

  constructor(
    private options: FireFlyWebSocketOptions,
    private callback: FireFlyWebSocketCallback,
  ) {
    this.connect();
  }

  private connect() {
    // Ensure we've cleaned up any old socket
    this.close();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      delete this.reconnectTimer;
    }

    const auth =
      this.options.username && this.options.password
        ? `${this.options.username}:${this.options.password}`
        : undefined;
    const socket = (this.socket = new WebSocket(`${this.options.host}/ws`, {
      auth,
      handshakeTimeout: this.options.heartbeatInterval,
    }));
    this.closed = false;
    socket
      .on('open', () => {
        if (this.disconnectDetected) {
          this.disconnectDetected = false;
          console.log('Connection restored');
        } else {
          console.log('Connected');
        }
        this.schedulePing();
        socket.send(
          JSON.stringify({
            type: 'start',
            autoack: false,
            namespace: this.options.namespace,
            name: this.options.subscriptionName,
          }),
        );
        console.log(
          `Started listening on subscription ${this.options.namespace}:${this.options.subscriptionName}`,
        );
      })
      .on('error', (err) => {
        console.error('Error', err.stack);
      })
      .on('close', () => {
        if (this.closed) {
          console.log('Closed');
        } else {
          this.disconnectDetected = true;
          this.reconnect('Closed by peer');
        }
      })
      .on('pong', () => {
        console.debug(`WS received pong`);
        this.schedulePing();
      })
      .on('unexpected-response', (req, res: IncomingMessage) => {
        let responseData = '';
        res.pipe(
          new Transform({
            transform(chunk, encoding, callback) {
              responseData += chunk;
              callback();
            },
            flush: () => {
              this.reconnect(`FireFly connect error [${res.statusCode}]: ${responseData}`);
            },
          }),
        );
      })
      .on('message', (data: string) => {
        const event: FireFlyEvent = JSON.parse(data);
        this.callback(this, event);
      });
  }

  private clearPingTimers() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      delete this.disconnectTimer;
    }
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      delete this.pingTimer;
    }
  }

  private schedulePing() {
    this.clearPingTimers();
    this.disconnectTimer = setTimeout(
      () => this.reconnect('Heartbeat timeout'),
      Math.ceil(this.options.heartbeatInterval * 1.5), // 50% grace period
    );
    this.pingTimer = setTimeout(() => {
      console.debug(`WS sending ping`);
      this.socket?.ping('ping', true, (err) => {
        if (err) this.reconnect(err.message);
      });
    }, this.options.heartbeatInterval);
  }

  private reconnect(msg: string) {
    if (!this.reconnectTimer) {
      this.close();
      console.error(`Websocket closed: ${msg}`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.options.reconnectDelay);
    }
  }

  ack(event: FireFlyEvent) {
    if (this.socket !== undefined && event.id !== undefined) {
      this.socket.send(
        JSON.stringify({
          type: 'ack',
          id: event.id,
          subscription: event.subscription,
        }),
      );
    }
  }

  close() {
    this.closed = true;
    this.clearPingTimers();
    if (this.socket) {
      try {
        this.socket.close();
      } catch (e: any) {
        console.warn(`Failed to clean up websocket: ${e.message}`);
      }
      this.socket = undefined;
    }
  }
}
