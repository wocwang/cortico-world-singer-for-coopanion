import type { ToolSpec } from 'cortico/core/types.ts';

/** 工具声明（不含 handler）；`describe.tools` 与 `tools()` 都从这里取。 */
export const SINGER_TOOL_DECLS: readonly ToolSpec[] = [{
  name: 'singer_sing',
  description: 'Sing one line aloud on this computer in your singing voice. Emit it in the same reply as the pet_say that shows the same line, immediately followed by that pet_say, without waiting for this result: tools run in order, so the bubble appears as the voice begins. Write Chinese lyrics as Han characters, Japanese as kana (needs a Japanese voicebank), English as space-separated words.',
  tags: ['speak'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { lyrics: { type: 'string', maxLength: 2000, description: 'The lyric line to sing.' } },
    required: ['lyrics'],
  },
}];
