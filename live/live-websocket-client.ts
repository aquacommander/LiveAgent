import type {
  ClientToServerMessage,
  ServerToClientMessage,
} from '../types/live-protocol';

type MessageHandler = (event: ServerToClientMessage) => void;
type ErrorHandler = (message: string) => void;
type CloseHandler = (reason?: string) => void;

export class LiveWebSocketClient {
  private socket: WebSocket | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private errorHandlers = new Set<ErrorHandler>();
  private closeHandlers = new Set<CloseHandler>();
  private isConnected = false;

  async connect(endpoint: string): Promise<void> {
    if (this.socket && this.isConnected) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(endpoint);
      this.socket = socket;
      let settled = false;

      const settleResolve = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const settleReject = (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      socket.addEventListener('open', () => {
        this.isConnected = true;
        settleResolve();
      });

      socket.addEventListener('message', (event: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(event.data) as ServerToClientMessage;
          this.messageHandlers.forEach((handler) => handler(parsed));
        } catch (error) {
          this.errorHandlers.forEach((handler) =>
            handler(
              error instanceof Error
                ? error.message
                : 'Failed to parse server message.',
            ),
          );
        }
      });

      socket.addEventListener('error', () => {
        this.errorHandlers.forEach((handler) =>
          handler('WebSocket encountered an error.'),
        );
      });

      socket.addEventListener('close', (event) => {
        this.isConnected = false;
        this.closeHandlers.forEach((handler) => handler(event.reason));
      });

      socket.addEventListener('error', () =>
        settleReject(new Error('Unable to connect to live backend.')),
      );
    });
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  send(message: ClientToServerMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Live websocket is not open.');
    }
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    if (this.socket) {
      this.socket.close(1000, 'Client closed session.');
      this.socket = null;
    }
    this.isConnected = false;
  }
}
