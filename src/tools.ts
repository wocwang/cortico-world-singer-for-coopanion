import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明（不含 handler）；`describe.tools` 与 `tools()` 都从这里取。 */
export const SINGER_TOOL_DECLS: readonly ToolSpec[] = [{
  name: 'singer_sing',
  description: 'Sing one line aloud on this computer in your singing voice. Use it whenever the person asks you to sing, hum, or casually "sing a few lines": actually sing instead of only answering in text. Call it first, wait for this result, then call pet_say with exactly the text this tool returns (the lyric line) so the bubble appears together with the voice. If the person asks to sing slower/faster, higher/lower or in a different mood, pass bpm / keyShift / scale in this same call: they take effect for this line and stay in effect for later lines until changed again. To sing a melody you wrote (for example the line you just gave compose_phrase or compose_render), put that same lead-sheet text in melody, with meter matching the compose section: each pitch needs one lyric syllable, "-" holds it and "." rests. To sing over a song you composed, pass the wav file compose_render returned as backing: it is mixed under the vocal and plays together with it from the same start. Set hear to true when you want this exact recording (with the backing) back as audio. Write Chinese lyrics as Han characters, Japanese as kana (needs a Japanese voicebank), English as space-separated words.',
  tags: ['speak'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      lyrics: { type: 'string', maxLength: 2000, description: 'The lyric line to sing.' },
      melody: { type: 'string', maxLength: 4000, description: 'Optional melody in the same lead-sheet text compose uses, e.g. "C4 D4 E4 - | G4 - - ."; "-" holds, "." rests, "|" separates bars. Omit to let the singer invent the melody.' },
      meter: { type: 'string', maxLength: 16, description: 'Meter of melody, e.g. 4/4 or 3/4; matched to the compose section. Default 4/4.' },
      backing: { type: 'string', maxLength: 1024, description: 'Absolute path to a PCM16 wav to play under this line, e.g. the file compose_render returned (render the section without a melody for a clean backing). The vocal is mixed over it and they start together.' },
      hear: { type: 'boolean', description: 'Return this line\'s recording as an audio attachment so you can hear it (works when the model upstream accepts audio).' },
      bpm: { type: 'integer', minimum: 60, maximum: 200, description: 'Tempo. 96 is the default; lower means slower ("唱慢一点" → 60–80).' },
      keyShift: { type: 'integer', minimum: -12, maximum: 12, description: 'Transpose in semitones, positive is higher ("调高点" → +2..+4).' },
      scale: { type: 'string', enum: ['major', 'minor'], description: 'Major is bright, minor is moody ("换小调" → minor).' },
    },
    required: ['lyrics'],
  },
}];
