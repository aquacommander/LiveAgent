import dotenv from 'dotenv';

dotenv.config();

function mustGet(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  geminiApiKey: mustGet('GEMINI_API_KEY'),
  defaultModel:
    process.env.GEMINI_MODEL ??
    'gemini-2.5-flash-native-audio-preview-09-2025',
  defaultVoice: process.env.GEMINI_VOICE ?? 'Orus',
};
