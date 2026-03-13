

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/6f23f979-e744-4437-ad6c-f2d31cb17432

## Architecture

- Frontend: Lit + Three.js realtime orb UI (`index.tsx`)
- Backend: WebSocket live bridge for Gemini Live (`backend/src/server.ts`)
- Media:
  - Microphone stream to model
  - Camera snapshots to model (vision-enabled)
  - Realtime model audio playback in browser

## Run Locally

**Prerequisites:** Node.js 18+ and npm

### 1) Install dependencies

```bash
npm install
npm --prefix backend install
```

### 2) Configure environment

Create backend env:

```bash
copy backend\.env.example backend\.env
```

Set your real `GEMINI_API_KEY` in `backend/.env`.

Create frontend env:

```bash
copy .env.example .env.local
```

`VITE_LIVE_WS_URL` defaults to `ws://localhost:8080/live`.

### 3) Start backend

```bash
npm run dev:backend
```

### 4) Start frontend

In another terminal:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Deploy on Google Cloud (recommended)

- Deploy `backend/` as a container to Cloud Run.
- Set `GEMINI_API_KEY` in Secret Manager and expose as env var.
- Host frontend via Firebase Hosting or Cloud Storage + CDN.
- Set frontend `VITE_LIVE_WS_URL` to your Cloud Run WebSocket endpoint.

### Build backend container

```bash
cd backend
docker build -t audio-orb-live-backend .
```
