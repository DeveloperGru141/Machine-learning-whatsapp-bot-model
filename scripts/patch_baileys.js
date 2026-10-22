/**
 * Post-install patch for @whiskeysockets/baileys.
 * 
 * Issue:
 * In Baileys' messages-recv.js, when an incoming message fails decryption (CIPHERTEXT / stub=2),
 * Baileys executes: `await sendRetryRequest(node, !encNode);`.
 * Because `encNode` is always present on ciphertext messages, `!encNode` evaluates to `false`.
 * This results in retry receipts being sent WITHOUT the bot's prekey bundle.
 * If the sender had an "Invalid PreKey ID" or a missing Signal session record,
 * the sender's device cannot re-negotiate the pairwise session or send an SKDM,
 * causing messages in groups or DMs to remain undecryptable stubs forever.
 * 
 * Fix:
 * Patch `messages-recv.js` to always pass `true` (forceIncludeKeys) on decryption failure,
 * ensuring the retry packet contains the bot's current identity, signedPreKey, and fresh prekey.
 */

const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'messages-recv.js');

if (!fs.existsSync(targetFile)) {
  console.log('[patch_baileys] Target file not found (baileys might not be installed yet), skipping patch.');
  process.exit(0);
}

try {
  let content = fs.readFileSync(targetFile, 'utf8');
  const oldCode = 'await sendRetryRequest(node, !encNode);';
  const newCode = 'await sendRetryRequest(node, true);';

  if (content.includes(oldCode)) {
    content = content.replace(oldCode, newCode);
    fs.writeFileSync(targetFile, content, 'utf8');
    console.log('[patch_baileys] ✅ Successfully patched Baileys messages-recv.js to always include keys in retry requests.');
  } else if (content.includes(newCode)) {
    console.log('[patch_baileys] ℹ️ Baileys messages-recv.js is already patched.');
  } else {
    console.warn('[patch_baileys] ⚠️ Target pattern not found in messages-recv.js; skipping patch.');
  }
} catch (err) {
  console.error('[patch_baileys] ❌ Failed to patch Baileys:', err.message);
}
