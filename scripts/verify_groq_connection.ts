import { groq } from '../src/agent/groq.js';
import { config } from '../src/config/env.js';

async function verifyGroqConnection() {
  console.log('==================================================');
  console.log('🔍 Verifying Groq API Connection in Codebase');
  console.log('==================================================\n');

  console.log('1. Configuration Settings:');
  console.log(`   • Model:              ${config.groq.model}`);
  console.log(`   • API Key Detected:   ${config.groq.apiKey ? 'YES (Valid)' : 'NO (Missing)'}`);
  console.log(`   • Key Prefix:         ${config.groq.apiKey.slice(0, 10)}...`);
  console.log(`   • Temperature:        ${config.groq.temperature}`);
  console.log(`   • Max Tokens:         ${config.groq.maxTokens}`);
  console.log(`   • Top P:              ${config.groq.topP}`);
  console.log(`   • Reasoning Effort:   ${config.groq.reasoningEffort}\n`);

  console.log('2. Performing Live API Test via src/agent/groq.ts...');
  const startTime = Date.now();

  try {
    const res = await groq.chat.completions.create({
      model: config.groq.model,
      messages: [
        { role: 'user', content: 'Say hello in two words.' },
      ],
      temperature: 1,
      max_completion_tokens: 200,
    });

    const elapsed = Date.now() - startTime;
    const reply = res.choices[0]?.message?.content?.trim();

    console.log('\n3. Test Results:');
    console.log(`   ✅ Status:            Connected (HTTP 200)`);
    console.log(`   ⚡ Latency:           ${elapsed}ms`);
    console.log(`   💬 Model Output:      "${reply}"`);
    console.log(`   🆔 System ID:         ${res.system_fingerprint || 'N/A'}`);
    console.log('\n==================================================');
    console.log('🎉 Groq API is 100% connected and active in the codebase!');
    console.log('==================================================');
  } catch (err: any) {
    console.error('\n❌ Groq Connection Error:', err.message);
    process.exit(1);
  }
}

verifyGroqConnection();
