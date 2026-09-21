import { env } from '../../config/env';

/**
 * Speech-to-text through any server that implements OpenAI's `POST {base}/audio/transcriptions` (OpenAI Whisper,
 * Groq, or a self-hosted faster-whisper-server / LocalAI), so the provider is a configuration choice, not a code one.
 * Speaker names are not detected: what comes back is plain text.
 */
export const AUDIO_FORMATS = ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'ogg', 'flac'] as const;

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg', mpeg: 'audio/mpeg', mpga: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac',
};
export const audioMime = (filename: string) => MIME[filename.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';

/** Magic-byte check so a renamed file cannot pass as audio. */
export function sniffAudio(b: Buffer, ext: string) {
  const at = (off: number, s: string) => b.subarray(off, off + s.length).toString('latin1') === s;
  switch (ext) {
    case 'mp3': case 'mpeg': case 'mpga': return at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case 'wav': return at(0, 'RIFF') && at(8, 'WAVE');
    case 'ogg': return at(0, 'OggS');
    case 'flac': return at(0, 'fLaC');
    case 'm4a': case 'mp4': return at(4, 'ftyp');
    case 'webm': return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    default: return false;
  }
}

/** `retryable` failures (network, rate limits, provider errors) are worth another attempt; the rest will fail the same way again. */
export class TranscriptionError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

interface TranscribeConfig { apiKey?: string; baseUrl: string; explicitBase: boolean; model: string; credits: number; timeoutMs: number }

const fromEnv = (): TranscribeConfig => ({
  apiKey: env.TRANSCRIBE_API_KEY || undefined,
  baseUrl: (env.TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  explicitBase: !!env.TRANSCRIBE_BASE_URL,
  model: env.TRANSCRIBE_MODEL,
  credits: env.TRANSCRIBE_CREDITS,
  timeoutMs: 10 * 60_000,
});

let cfg = fromEnv();

/** Test hook: override configuration. Call with no argument to restore the environment. */
export function configureTranscription(o?: Partial<TranscribeConfig>) {
  cfg = { ...fromEnv(), ...o };
}

/** On when a key is set, or a base URL is (self-hosted servers often need no key). */
export const transcriptionEnabled = () => !!(cfg.apiKey || cfg.explicitBase);
/** AI-request credits one transcription costs. */
export const transcriptionCredits = () => cfg.credits;

export async function transcribe(audio: Buffer, filename: string, mime: string): Promise<{ text: string }> {
  const form = new FormData();
  // (cast: Node's Buffer is typed over ArrayBufferLike, Blob wants ArrayBuffer; the bytes are identical and this avoids a copy)
  form.append('file', new Blob([audio as unknown as Uint8Array<ArrayBuffer>], { type: mime }), filename);
  form.append('model', cfg.model);
  form.append('response_format', 'json');

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
      body: form,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    throw new TranscriptionError(`Could not reach the transcription service (${String(e).slice(0, 80)}).`, true);
  }

  const json = (await res.json().catch(() => null)) as { text?: unknown; error?: { message?: string } | string } | null;
  if (!res.ok) {
    const detail = typeof json?.error === 'string' ? json.error : json?.error?.message;
    if (res.status === 401 || res.status === 403) {
      throw new TranscriptionError("The transcription service rejected this server's credentials. An administrator needs to check TRANSCRIBE_API_KEY.", false);
    }
    if (res.status === 429 || res.status >= 500) throw new TranscriptionError(`The transcription service is busy or unavailable (HTTP ${res.status}).`, true);
    throw new TranscriptionError(`The recording could not be transcribed${detail ? `: ${detail.slice(0, 200)}` : ' (unsupported, corrupted or too large)'}.`, false);
  }
  const text = typeof json?.text === 'string' ? json.text.trim() : '';
  if (!text) throw new TranscriptionError('No speech was detected in the recording.', false);
  return { text };
}
