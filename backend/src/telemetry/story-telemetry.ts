type TelemetryPayload = Record<string, unknown>;

export function emitStoryTelemetry(event: string, payload: TelemetryPayload): void {
  if (process.env.STORY_TELEMETRY === 'false') {
    return;
  }
  const data = {
    namespace: 'creative_storyteller',
    event,
    timestamp: new Date().toISOString(),
    ...payload,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(data));
}
