import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明（不含 handler）；`describe.tools` 与 `tools()` 都从这里取。 */
export const SINGER_TOOL_DECLS: readonly ToolSpec[] = [{
  name: 'singer_sing',
  description: 'Sing one line aloud on this computer in your singing voice. Use it whenever the person asks you to sing, hum, or casually "sing a few lines": actually sing instead of only answering in text. Call it first, wait for this result, then call pet_say with exactly the text this tool returns (the lyric line) so the bubble appears together with the voice. If the person asks to sing slower/faster, higher/lower or in a different mood, pass bpm / keyShift / scale in this same call: they take effect for this line and stay in effect for later lines until changed again. Write Chinese lyrics as Han characters, Japanese as kana (needs a Japanese voicebank), English as space-separated words.',
  tags: ['speak'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      lyrics: { type: 'string', maxLength: 2000, description: 'The lyric line to sing.' },
      bpm: { type: 'integer', minimum: 60, maximum: 200, description: 'Tempo. 96 is the default; lower means slower ("唱慢一点" → 60–80).' },
      keyShift: { type: 'integer', minimum: -12, maximum: 12, description: 'Transpose in semitones, positive is higher ("调高点" → +2..+4).' },
      scale: { type: 'string', enum: ['major', 'minor'], description: 'Major is bright, minor is moody ("换小调" → minor).' },
    },
    required: ['lyrics'],
  },
}];
