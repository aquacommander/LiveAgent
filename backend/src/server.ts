import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  GoogleGenAI,
  type LiveServerMessage,
  Modality,
  type Session,
} from '@google/genai';
import { config } from './config.js';
import type {
  ClientToServerMessage,
  ServerToClientMessage,
} from './protocol.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/live',
});

function send(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}

function extractText(message: LiveServerMessage): string | null {
  const parts = message.serverContent?.modelTurn?.parts;
  if (!parts?.length) {
    return null;
  }
  const textParts = parts
    .map((part) => part.text ?? '')
    .filter((part) => part.length > 0);
  if (!textParts.length) {
    return null;
  }
  return textParts.join('\n');
}

function extractAudio(message: LiveServerMessage): {
  data: string;
  mimeType: string;
} | null {
  const parts = message.serverContent?.modelTurn?.parts;
  if (!parts?.length) {
    return null;
  }
  const inlineData = parts.find((part) => !!part.inlineData)?.inlineData;
  if (!inlineData?.data || !inlineData?.mimeType) {
    return null;
  }
  return {
    data: inlineData.data,
    mimeType: inlineData.mimeType,
  };
}

wss.on('connection', (socket) => {
  const client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  let session: Session | null = null;
  let isSessionStarting = false;
  let isSessionReady = false;
  const pendingInputs: Array<
    Extract<ClientToServerMessage, { type: 'input_audio' | 'input_image' | 'input_text' }>
  > = [];

  const forwardInput = async (
    inputMessage: Extract<
      ClientToServerMessage,
      { type: 'input_audio' | 'input_image' | 'input_text' }
    >,
  ): Promise<void> => {
    if (!session) {
      throw new Error('No active live session.');
    }

    if (inputMessage.type === 'input_audio' || inputMessage.type === 'input_image') {
      await session.sendRealtimeInput({
        media: {
          data: inputMessage.payload.data,
          mimeType: inputMessage.payload.mimeType,
        },
      });
      return;
    }

    await session.sendRealtimeInput({
      text: inputMessage.payload.text,
    });
  };

  send(socket, {
    type: 'status',
    payload: { message: 'Connected to backend.' },
  });

  socket.on('message', async (rawData: Buffer) => {
    let message: ClientToServerMessage;

    try {
      message = JSON.parse(rawData.toString()) as ClientToServerMessage;
    } catch (error) {
      send(socket, {
        type: 'error',
        payload: {
          message:
            error instanceof Error
              ? error.message
              : 'Invalid JSON message from client.',
        },
      });
      return;
    }

    try {
      if (message.type === 'start_session') {
        if (session) {
          await session.close();
          session = null;
        }
        pendingInputs.length = 0;
        isSessionReady = false;
        isSessionStarting = true;
        send(socket, {
          type: 'status',
          payload: { message: 'Starting live session...' },
        });

        const model = message.payload?.model ?? config.defaultModel;
        const voiceName = message.payload?.voiceName ?? config.defaultVoice;
        const requestedModalities = message.payload?.responseModalities ?? [
          'AUDIO',
        ];

        const responseModalities =
          requestedModalities.includes('TEXT') && requestedModalities.includes('AUDIO')
            ? [Modality.TEXT, Modality.AUDIO]
            : requestedModalities.includes('TEXT')
              ? [Modality.TEXT]
              : [Modality.AUDIO];

        session = await client.live.connect({
          model,
          callbacks: {
            onopen: () => {
              isSessionStarting = false;
              isSessionReady = true;
              send(socket, {
                type: 'session_ready',
                payload: { message: 'Gemini Live session opened.' },
              });
              void (async () => {
                while (pendingInputs.length) {
                  const queuedInput = pendingInputs.shift();
                  if (!queuedInput) {
                    break;
                  }
                  await forwardInput(queuedInput);
                }
              })();
            },
            onmessage: (liveMessage: LiveServerMessage) => {
              const audio = extractAudio(liveMessage);
              if (audio) {
                send(socket, {
                  type: 'model_audio',
                  payload: audio,
                });
              }

              const text = extractText(liveMessage);
              if (text) {
                send(socket, {
                  type: 'model_text',
                  payload: { text },
                });
              }

              if (liveMessage.serverContent?.interrupted) {
                send(socket, { type: 'interrupted' });
              }
            },
            onerror: (event: { message?: string }) => {
              send(socket, {
                type: 'error',
                payload: { message: event.message ?? 'Gemini session error.' },
              });
            },
            onclose: (event: { reason?: string }) => {
              isSessionReady = false;
              isSessionStarting = false;
              send(socket, {
                type: 'status',
                payload: {
                  message: `Gemini session closed: ${event.reason ?? 'no reason'}`,
                },
              });
            },
          },
          config: {
            responseModalities,
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName } },
            },
          },
        });

        return;
      }

      if (
        message.type === 'input_audio' ||
        message.type === 'input_image' ||
        message.type === 'input_text'
      ) {
        if (isSessionStarting && !isSessionReady) {
          pendingInputs.push(message);
          return;
        }

        if (!session || !isSessionReady) {
          send(socket, {
            type: 'error',
            payload: { message: 'Session is not ready yet. Please retry.' },
          });
          return;
        }

        await forwardInput(message);
        return;
      }

      if (!session) {
        send(socket, {
          type: 'error',
          payload: { message: 'No live session. Send start_session first.' },
        });
        return;
      }

      if (message.type === 'end_session') {
        await session.close();
        session = null;
        isSessionReady = false;
        isSessionStarting = false;
        pendingInputs.length = 0;
        send(socket, {
          type: 'status',
          payload: { message: 'Session ended.' },
        });
      }
    } catch (error) {
      send(socket, {
        type: 'error',
        payload: {
          message:
            error instanceof Error ? error.message : 'Unexpected server error.',
        },
      });
    }
  });

  socket.on('close', async () => {
    if (session) {
      await session.close();
      session = null;
    }
  });
});

server.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Live backend listening on http://localhost:${config.port}`);
});
