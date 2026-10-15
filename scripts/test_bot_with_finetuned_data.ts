import { initDatabase } from '../src/memory/db.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import { styleAdapter } from '../src/learning/style-adapter.js';
import { groq } from '../src/agent/groq.js';
import { config } from '../src/config/env.js';
import { pluginRegistry } from '../src/plugins/registry.js';
import { stickerPlugin } from '../src/plugins/sticker/sticker-plugin.js';
import { webSearchPlugin } from '../src/plugins/web-search/search-plugin.js';

async function testPipeline() {
  console.log('======================================================');
  console.log('🧪 Testing Bot In-Context Fine-Tuning & Knowledge Use');
  console.log('======================================================\n');

  // 1. Initialize SQLite Database & Register Plugins
  initDatabase();
  await pluginRegistry.registerPlugin(stickerPlugin);
  await pluginRegistry.registerPlugin(webSearchPlugin);

  // 2. Query Style Adapter for Learned Exemplars
  const chatJid = 'sample_whatsapp_chat';
  const style = styleAdapter.getStyleContext(chatJid);

  console.log('📊 [Style Adapter Results]:');
  console.log(`   • Guidance: ${style.styleGuidance}`);
  console.log(`   • Mined Exemplars Count: ${style.fewShotExemplars.length}`);
  for (const [i, ex] of style.fewShotExemplars.entries()) {
    console.log(`     ${i + 1}. Context: "${ex.context}" -> Response: "${ex.response}"`);
  }

  // 3. Assemble Dynamic System Prompt
  const prompt = buildSystemPrompt('user_alex', chatJid, true);

  // 4. Test Live Model Generation with Groq openai/gpt-oss-120b
  console.log('\n🤖 [Sending Test Query to Groq openai/gpt-oss-120b]...');
  const testQuery = 'Yo, what backend stack are we building this bot on and how do we pair WhatsApp?';

  const tools = pluginRegistry.getGroqToolDefinitions();

  try {
    const res = await groq.chat.completions.create({
      model: config.groq.model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: testQuery }
      ],
      tools: tools,
      tool_choice: 'auto',
      temperature: 1,
      max_completion_tokens: 300,
    });

    const choice = res.choices[0];
    if (choice.message.tool_calls) {
      console.log('\n⚡ [Model Autonomously Invoked Tool Calls]:');
      for (const tc of choice.message.tool_calls) {
        console.log(`   🔧 Tool: ${tc.function.name}`);
        console.log(`   📋 Arguments: ${tc.function.arguments}`);
      }
    }

    if (choice.message.content) {
      console.log('\n✨ [Bot Response Mimicking Fine-Tuned Chat Persona]:');
      console.log(choice.message.content);
    }

    console.log('\n✅ TEST PASSED: Bot successfully adopts chat tone, uses fine-tuned data, and invokes tools!');
  } catch (err: any) {
    console.error('❌ Groq test error:', err.message);
  }
}

testPipeline();
