import fs from 'fs';
import path from 'path';
import { db } from '../memory/db.js';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../plugins/types.js';

export class DatasetExporterPlugin implements IPlugin {
  name = 'DatasetExporter';
  version = '1.0.0';
  description = 'Compiles learned multi-chat dialogue patterns into an OpenAI/Groq compatible JSONL fine-tuning dataset';

  tools: BotTool[] = [
    {
      name: 'export_training_data',
      description: 'Exports all learned chat interactions, successful exemplars, and dialogue pairs into an offline JSONL dataset ready for fine-tuning.',
      parameters: {
        type: 'object',
        properties: {
          minQualityScore: {
            type: 'number',
            description: 'Minimum exemplar quality score to include (default 1.0).',
          },
        },
      },
      execute: async (args: { minQualityScore?: number }, ctx: ExecutionContext): Promise<ToolResult> => {
        try {
          const outputPath = path.resolve('./data/finetune_dataset.jsonl');
          const minScore = args.minQualityScore ?? 1.0;

          // 1. Fetch learned dialogue exemplars
          const exemplars = db.prepare(`
            SELECT context_text, response_text, response_type, vibe_classification
            FROM dialogue_exemplars
            WHERE quality_score >= ? AND response_text IS NOT NULL
            ORDER BY id ASC
          `).all(minScore) as unknown as Array<{
            context_text: string;
            response_text: string;
            response_type: string;
            vibe_classification: string;
          }>;

          // 2. Fetch recorded fine-tuning pairs
          const directPairs = db.prepare(`
            SELECT system_prompt, user_message, assistant_response
            FROM fine_tuning_pairs
            ORDER BY id ASC
          `).all() as unknown as Array<{
            system_prompt: string;
            user_message: string;
            assistant_response: string;
          }>;

          const lines: string[] = [];

          // Format direct pairs
          for (const p of directPairs) {
            lines.push(
              JSON.stringify({
                messages: [
                  { role: 'system', content: p.system_prompt },
                  { role: 'user', content: p.user_message },
                  { role: 'assistant', content: p.assistant_response },
                ],
              })
            );
          }

          // Format mined exemplars
          for (const e of exemplars) {
            lines.push(
              JSON.stringify({
                messages: [
                  {
                    role: 'system',
                    content: `You are an expressive, witty WhatsApp assistant mimicking natural human banter.`,
                  },
                  { role: 'user', content: e.context_text },
                  { role: 'assistant', content: e.response_text },
                ],
              })
            );
          }

          fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');

          return {
            success: true,
            message: `Successfully exported ${lines.length} fine-tuning training pairs to: data/finetune_dataset.jsonl`,
            data: { totalSamples: lines.length, filePath: outputPath },
          };
        } catch (err: any) {
          return { success: false, message: `Failed to export dataset: ${err.message}` };
        }
      },
    },
  ];
}

export const datasetExporterPlugin = new DatasetExporterPlugin();
