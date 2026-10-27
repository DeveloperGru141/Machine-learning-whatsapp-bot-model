export interface SensitiveDetectionResult {
  scrubbedText: string;
  isSensitive: boolean;
  detectedCategories: string[];
}

export class SensitiveDataFilter {
  private emailRegex = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  private whatsappJidRegex = /\b[\w.-]+@(?:s\.whatsapp\.net|lid|g\.us)\b/gi;
  private phoneRegex = /(?<!\w)\+?\d[\d\s().-]{6,}\d(?!\w)/g;

  // 1. API Keys, Secrets & Access Tokens
  private apiKeyRegexes = [
    /\b(?:sk-[a-zA-Z0-9]{20,48})\b/g, // OpenAI
    /\b(?:gsk_[a-zA-Z0-9]{20,64})\b/g, // Groq
    /\b(?:AIzaSy[a-zA-Z0-9_-]{33})\b/g, // Google / Gemini
    /\b(?:gh[pousr]_[a-zA-Z0-9]{36,255})\b/g, // GitHub tokens
    /\b(?:AKIA[0-9A-Z]{16})\b/g, // AWS Access Key
    /\b(?:Bearer\s+[a-zA-Z0-9_\-\.]{20,})\b/gi, // Generic Bearer token
    /\b(?:xox[baprs]-[0-9a-zA-Z]{10,48})\b/g, // Slack token
  ];

  // 2. Debit & Credit Cards (Visa, Mastercard, Verve, Amex)
  private cardRegex = /\b(?:\d{4}[ -]?){3}\d{4}\b|\b506[0-9]{15,16}\b|\b650[0-9]{13,16}\b/g;
  private cvvRegex = /\b(?:cvv|cvc|security code)[:\s]*\d{3,4}\b/gi;
  private cardExpiryRegex = /\b(?:exp(?:iry)?|valid thru)[:\s]*(?:0[1-9]|1[0-2])\/[0-9]{2,4}\b/gi;

  // 3. Nigerian Bank Verification Number (BVN) & National Identity Number (NIN)
  // Handles: "BVN is 123...", "BVN: 123...", "BVN 123...", "my NIN is 123..."
  private bvnRegex = /\b(?:bvn|bank verification number)(?:[:\s]+(?:is|number|no|:)?[:\s]*)?(\d{11})\b/gi;
  private ninRegex = /\b(?:nin|national id(?:entification)?(?: number)?)(?:[:\s]+(?:is|number|no|:)?[:\s]*)?(\d{11})\b/gi;

  // 4. Nigerian Bank Accounts in Context (10 digits + bank name or "acct/account")
  private bankAccountRegex =
    /\b(?:(?:acct(?:\s*no)?|account(?:\s*number)?|send\s*(?:money|funds)\s*to|credit|transfer\s*to)[:\s]*(\d{10})|(\d{10})\s*(?:gtb|gtbank|access|zenith|firstbank|uba|opay|palmpay|kuda|fcmb|fidelity|stanbic|union|wema|polaris|sterling|providus|jaiz|taj|keystone))\b/gi;

  // 5. Passwords, Transaction PINs & ATM PINs
  private passwordPinRegex =
    /\b(?:password|passwd|pwd|passcode|transaction\s*pin|atm\s*pin|transfer\s*pin|login\s*pin)(?:[:\s]+(?:is|:)?[:\s]*)?([^\s,]{4,32})\b/gi;

  // 6. One-Time Passwords (OTPs) and 2FA Verification Codes
  private otpRegex =
    /\b(?:your\s+)?(?:otp|verification\s*code|security\s*code|login\s*code|sms\s*code|confirmation\s*code|use\s*code)(?:[:\s]+(?:is|code|:)?[:\s]*)?(\d{4,8})\b/gi;

  // 7. Cryptocurrency 12/24 Word Seed Phrases & Private Keys
  private privateKeyRegex = /\b(?:0x[a-fA-F0-9]{64}|[5KL][1-9A-HJ-NP-za-km-z]{50,51})\b/g;
  private seedPhraseLeadInRegex =
    /\b(?:seed\s*phrase|recovery\s*phrase|secret\s*words|backup\s*phrase)[:\s]*((?:[a-z]{3,10}\s+){11,23}[a-z]{3,10})\b/gi;

  /**
   * Safe stateless regex testing that avoids RegExp.lastIndex statefulness bugs
   */
  private testRegex(reg: RegExp, text: string): boolean {
    reg.lastIndex = 0;
    return reg.test(text);
  }

  /**
   * Evaluates if text contains unredacted credentials or sensitive information that must
   * NEVER be exported or stored in the ML model training/fine-tuning dataset.
   */
  public shouldExcludeFromTraining(text?: string | null): boolean {
    if (!text || typeof text !== 'string') return false;

    if (this.testRegex(this.emailRegex, text)) return true;
    if (this.testRegex(this.whatsappJidRegex, text)) return true;
    if (this.testRegex(this.phoneRegex, text)) return true;

    // Check API Keys & tokens
    for (const reg of this.apiKeyRegexes) {
      if (this.testRegex(reg, text)) return true;
    }

    // Check Cards, CVV, BVN, NIN, Passwords, PINs, OTPs, Crypto keys
    if (this.testRegex(this.cardRegex, text)) return true;
    if (this.testRegex(this.cvvRegex, text)) return true;
    if (this.testRegex(this.bvnRegex, text)) return true;
    if (this.testRegex(this.ninRegex, text)) return true;
    if (this.testRegex(this.bankAccountRegex, text)) return true;
    if (this.testRegex(this.passwordPinRegex, text)) return true;
    if (this.testRegex(this.otpRegex, text)) return true;
    if (this.testRegex(this.privateKeyRegex, text)) return true;
    if (this.testRegex(this.seedPhraseLeadInRegex, text)) return true;

    return false;
  }

  /**
   * Scrubs sensitive PII, credentials, banking data, and secrets from raw text,
   * replacing them with secure privacy placeholder tokens.
   */
  public scrubSensitiveText(text: string): SensitiveDetectionResult {
    if (!text || typeof text !== 'string') {
      return { scrubbedText: text || '', isSensitive: false, detectedCategories: [] };
    }

    let scrubbed = text;
    const detected: string[] = [];

    if (this.testRegex(this.emailRegex, scrubbed)) {
      detected.push('email');
      this.emailRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.emailRegex, '[REDACTED_EMAIL]');
    }
    if (this.testRegex(this.whatsappJidRegex, scrubbed)) {
      detected.push('whatsapp_identifier');
      this.whatsappJidRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.whatsappJidRegex, '[REDACTED_IDENTIFIER]');
    }
    if (this.testRegex(this.phoneRegex, scrubbed)) {
      detected.push('phone_number');
      this.phoneRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.phoneRegex, '[REDACTED_PHONE]');
    }

    // 1. Scrub API Keys
    for (const reg of this.apiKeyRegexes) {
      if (this.testRegex(reg, scrubbed)) {
        detected.push('api_key');
        reg.lastIndex = 0;
        scrubbed = scrubbed.replace(reg, '[REDACTED_API_KEY]');
      }
    }

    // 2. Scrub Debit/Credit Cards
    if (this.testRegex(this.cardRegex, scrubbed)) {
      detected.push('credit_card');
      this.cardRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.cardRegex, '[REDACTED_CARD_NUMBER]');
    }
    if (this.testRegex(this.cvvRegex, scrubbed)) {
      detected.push('cvv');
      this.cvvRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.cvvRegex, '[REDACTED_CVV]');
    }
    if (this.testRegex(this.cardExpiryRegex, scrubbed)) {
      detected.push('card_expiry');
      this.cardExpiryRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.cardExpiryRegex, '[REDACTED_EXPIRY]');
    }

    // 3. Scrub BVN & NIN
    if (this.testRegex(this.bvnRegex, scrubbed)) {
      detected.push('bvn');
      this.bvnRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.bvnRegex, (match, bvn) => match.replace(bvn, '[REDACTED_BVN]'));
    }
    if (this.testRegex(this.ninRegex, scrubbed)) {
      detected.push('nin');
      this.ninRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.ninRegex, (match, nin) => match.replace(nin, '[REDACTED_NIN]'));
    }

    // 4. Scrub Passwords and Transaction PINs
    if (this.testRegex(this.passwordPinRegex, scrubbed)) {
      detected.push('password_pin');
      this.passwordPinRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.passwordPinRegex, (match, p1) => match.replace(p1, '[REDACTED_PIN]'));
    }

    // 5. Scrub OTPs
    if (this.testRegex(this.otpRegex, scrubbed)) {
      detected.push('otp');
      this.otpRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.otpRegex, (match, p1) => match.replace(p1, '[REDACTED_OTP]'));
    }

    // 6. Scrub Crypto Private Keys & Seed Phrases
    if (this.testRegex(this.privateKeyRegex, scrubbed)) {
      detected.push('private_key');
      this.privateKeyRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.privateKeyRegex, '[REDACTED_PRIVATE_KEY]');
    }
    if (this.testRegex(this.seedPhraseLeadInRegex, scrubbed)) {
      detected.push('seed_phrase');
      this.seedPhraseLeadInRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.seedPhraseLeadInRegex, '[REDACTED_SEED_PHRASE]');
    }

    // 7. Scrub Bank Account Numbers only when an account label or bank name is present.
    if (this.testRegex(this.bankAccountRegex, scrubbed)) {
      detected.push('bank_account');
      this.bankAccountRegex.lastIndex = 0;
      scrubbed = scrubbed.replace(this.bankAccountRegex, (match, accountWithLabel, accountWithBank) =>
        match.replace(accountWithLabel || accountWithBank, '[REDACTED_ACCOUNT_NUMBER]')
      );
    }

    const uniqueDetected = Array.from(new Set(detected));
    return {
      scrubbedText: scrubbed,
      isSensitive: uniqueDetected.length > 0,
      detectedCategories: uniqueDetected,
    };
  }
}

export const sensitiveDataFilter = new SensitiveDataFilter();
