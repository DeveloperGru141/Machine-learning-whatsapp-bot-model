import fs from 'fs';
import path from 'path';
import { db } from '../memory/db.js';
import { IPlugin, BotTool, ExecutionContext, ToolResult } from '../plugins/types.js';
import { config } from '../config/env.js';
import { sensitiveDataFilter } from '../security/sensitive-data-filter.js';
import { userProfileManager } from '../memory/user-profiles.js';

export class DatasetExporterPlugin implements IPlugin {
  name = 'DatasetExporter';
  version = '1.0.0';
  description = 'Exports curated and public-source examples into a privacy-filtered JSONL dataset';

  tools: BotTool[] = [
    {
      name: 'export_training_data',
      description: 'Exports curated seed and public-dataset examples. Live conversations and imported private chats are excluded.',
      parameters: {
        type: 'object',
        properties: {
        },
      },
      execute: async (_args: {}, ctx: ExecutionContext): Promise<ToolResult> => {
        if (!userProfileManager.isOwner(ctx.senderJid, ctx.senderName)) {
          return {
            success: false,
            message: 'Permission denied: Only the bot creator (Ademola) has permission to export the fine-tuning training dataset.',
          };
        }

        try {
          const outputPath = path.resolve('./data/finetune_dataset.jsonl');

          const directPairs = db.prepare(`
            SELECT system_prompt, user_message, assistant_response
            FROM fine_tuning_pairs
            WHERE source_type IN ('bundled_curated', 'curated_seed', 'public_dataset')
            ORDER BY id ASC
          `).all() as unknown as Array<{
            system_prompt: string;
            user_message: string;
            assistant_response: string;
          }>;

          const lines: string[] = [];

          // Runtime conversations, memories, contact records, and mined exemplars never enter this export.
          for (const p of directPairs) {
            if (
              sensitiveDataFilter.shouldExcludeFromTraining(p.user_message) ||
              sensitiveDataFilter.shouldExcludeFromTraining(p.assistant_response)
            ) {
              continue;
            }
            if (sensitiveDataFilter.shouldExcludeFromTraining(p.system_prompt)) continue;
            const cleanSystem = sensitiveDataFilter.scrubSensitiveText(p.system_prompt).scrubbedText;
            const cleanUser = sensitiveDataFilter.scrubSensitiveText(p.user_message).scrubbedText;
            const cleanAsst = sensitiveDataFilter.scrubSensitiveText(p.assistant_response).scrubbedText;
            lines.push(
              JSON.stringify({
                messages: [
                  { role: 'system', content: cleanSystem },
                  { role: 'user', content: cleanUser },
                  { role: 'assistant', content: cleanAsst },
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
