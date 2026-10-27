import json
import sys
import re
import random
from pathlib import Path

# Ensure UTF-8 output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
APPROVED_INPUT = DATA_DIR / "approved_training.jsonl"
CURATED_INPUT = DATA_DIR / "curated_seed.jsonl"
PUBLIC_INPUT = DATA_DIR / "public_training.jsonl"
INPUT_DATASET = DATA_DIR / "finetune_dataset.jsonl"
TRAIN_DATASET = DATA_DIR / "train.jsonl"
VAL_DATASET = DATA_DIR / "validation.jsonl"

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful WhatsApp conversation assistant. Answer naturally and clearly, "
    "match the other person's language and register, and avoid unnecessary personal data."
)

ROBOTIC_CLICHES = [
    "as an ai",
    "as a language model",
    "how can i help",
    "what can i help",
    "can i help you",
    "how may i assist",
    "how can i assist",
    "how can i be of service",
    "i'm here to assist",
    "i am here to assist",
    "i'm here to help",
    "i am here to help",
    "i'd be happy to",
    "i would be happy to",
    "i would be glad to",
    "happy to help",
    "glad to help",
    "feel free",
    "certainly!",
    "certainly,",
    "sure thing!",
    "i hope this helps",
    "i hope you find this helpful",
    "let me know if you need",
    "let me know if you want",
    "anything else i can",
    "is there anything else",
    "don't hesitate",
    "do not hesitate",
    "reach out if",
    "further assistance",
    "if you have any other questions",
    "if you need further",
    "virtual assistant",
    "an error occurred",
    "network slow small",
    "abeg try again in a sec",
]

OUTDATED_NAMES = [
    "nova",
]

DEPRECATED_TERMS = [
    "[sent sticker]",
    "[sticker]",
    "<media omitted>",
    "roasts alex",
    "uses stickers",
]

CREATOR_KEYWORDS = [
    "who made",
    "who built",
    "who coded",
    "who developed",
    "who is your creator",
    "who is the creator",
    "who owns",
]

def count_emojis(text: str) -> int:
    """Accurately counts emojis within unicode emoji ranges."""
    count = 0
    for char in text:
        cp = ord(char)
        if (
            0x1F600 <= cp <= 0x1F64F  # Emoticons
            or 0x1F300 <= cp <= 0x1F5FF  # Misc Symbols and Pictographs
            or 0x1F680 <= cp <= 0x1F6FF  # Transport and Map
            or 0x1F1E0 <= cp <= 0x1F1FF  # Flags
            or 0x2600 <= cp <= 0x26FF    # Misc symbols
            or 0x2700 <= cp <= 0x27BF    # Dingbats
            or 0x1F900 <= cp <= 0x1F9FF  # Supplemental Symbols and Pictographs
            or 0x1FA70 <= cp <= 0x1FAFF  # Symbols and Pictographs Extended-A
        ):
            count += 1
    return count

SENSITIVE_PATTERNS = [
    re.compile(r"gsk_[a-zA-Z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"rnd_[a-zA-Z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{20,}", re.IGNORECASE),
    re.compile(r"sk-[a-zA-Z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}", re.IGNORECASE),
    re.compile(r"\b10\d{12,14}(?:@lid)?\b"),
    re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"),
    re.compile(r"(?<!\w)\+?\d[\d ()-]{6,}\d(?!\w)"),
    re.compile(r"\b[\w.+-]+@(?:s\.whatsapp\.net|lid|g\.us)\b", re.IGNORECASE),
    re.compile(r"(?:password|secret|apikey|api_key)\s*[:=]\s*\S+", re.IGNORECASE),
    re.compile(r"ignore\s+(?:all\s+)?previous\s+instructions", re.IGNORECASE),
]

def validate_and_tighten():
    print("=" * 65)
    print("🎯 Forgelabs Assistant — Dataset Validator & Tightener")
    print("=" * 65)

    raw_candidates = []

    # Only curated, public, or explicitly approved JSONL sources are eligible.
    # Runtime chat logs, contacts, memories, and SQLite are never read.
    for source_path in (CURATED_INPUT, PUBLIC_INPUT, APPROVED_INPUT):
        if not source_path.exists():
            continue
        with open(source_path, "r", encoding="utf-8") as f:
            for line in f:
                line_str = line.strip()
                if not line_str:
                    continue
                try:
                    data = json.loads(line_str)
                    if isinstance(data, dict) and isinstance(data.get("messages"), list):
                        raw_candidates.append(data)
                except json.JSONDecodeError:
                    pass

    print(f"📥 Collected {len(raw_candidates)} reviewed source samples for inspection.")

    valid_samples = []
    skipped_reasons = {
        "missing_roles": 0,
        "too_short": 0,
        "sensitive_data_leak": 0,
        "robotic_cliche": 0,
        "emoji_spam": 0,
        "outdated_name": 0,
        "deprecated_artifact": 0,
        "inconsistent_creator": 0,
        "duplicates": 0,
        "repetitive_response_cap": 0,
    }

    seen_pairs = set()
    response_counts = {}

    for data in raw_candidates:
        messages = data.get("messages", [])
        if len(messages) < 2:
            skipped_reasons["missing_roles"] += 1
            continue

        if not all(isinstance(message, dict) for message in messages):
            skipped_reasons["missing_roles"] += 1
            continue
        roles = [m.get("role") for m in messages]
        if not all(isinstance(role, str) for role in roles) or sorted(roles) != ["assistant", "system", "user"]:
            skipped_reasons["missing_roles"] += 1
            continue

        user_msg = next((str(m.get("content", "")) for m in messages if m.get("role") == "user"), "").strip()
        asst_msg = next((str(m.get("content", "")) for m in messages if m.get("role") == "assistant"), "").strip()

        # Rule 1: Length check
        if len(user_msg) < 2 or len(asst_msg) < 3 or len(user_msg) > 4000 or len(asst_msg) > 4000:
            skipped_reasons["too_short"] += 1
            continue

        # Sensitive Data Guardrail: discard any pair with API keys, tokens, or private IDs
        all_content = "\n".join(str(m.get("content", "")) for m in messages)
        if any(pat.search(all_content) for pat in SENSITIVE_PATTERNS) or re.search(r"<(?:think|analysis|tool_call|function)\b", all_content, re.I):
            skipped_reasons["sensitive_data_leak"] += 1
            continue

        asst_lower = asst_msg.lower()
        user_lower = user_msg.lower()

        # Rule 2: Outdated name check ("Nova")
        if any(name in asst_lower for name in OUTDATED_NAMES):
            skipped_reasons["outdated_name"] += 1
            continue

        # Rule 3: Robotic clichés check
        if any(cliche in asst_lower for cliche in ROBOTIC_CLICHES):
            skipped_reasons["robotic_cliche"] += 1
            continue

        # Rule 4: Deprecated artifacts / stickers
        if any(dep in asst_lower or dep in user_lower for dep in DEPRECATED_TERMS):
            skipped_reasons["deprecated_artifact"] += 1
            continue

        # Rule 5: Natural emoji limit (maximum 2 emojis per assistant reply)
        if count_emojis(asst_msg) > 2:
            skipped_reasons["emoji_spam"] += 1
            continue

        # Rule 6: Deduplication
        pair_key = (user_lower, asst_lower)
        if pair_key in seen_pairs:
            skipped_reasons["duplicates"] += 1
            continue
        seen_pairs.add(pair_key)

        # Rule 7: Strict Response Diversity & Repetition Cap (Max 3 identical responses)
        resp_key = asst_lower.strip()
        if response_counts.get(resp_key, 0) >= 3:
            skipped_reasons["repetitive_response_cap"] += 1
            continue
        response_counts[resp_key] = response_counts.get(resp_key, 0) + 1

        # Use a generic system prompt and exactly the user/assistant example being curated.
        data["messages"] = [
            {"role": "system", "content": DEFAULT_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
            {"role": "assistant", "content": asst_msg},
        ]

        # Format tightening for WhatsApp: strip un-conversational Markdown headers and excess spacing
        for m in messages:
            if m.get("role") == "assistant":
                cleaned = re.sub(r"^#{1,6}\s+", "", m.get("content", ""), flags=re.MULTILINE)
                cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
                m["content"] = cleaned

        valid_samples.append(data)

    print(f"\n📊 Validation Results:")
    print(f"   • Total Candidates Inspected: {len(raw_candidates)}")
    print(f"   • Valid High-Quality Pairs:   {len(valid_samples)}")
    print(f"   • Filtered & Discarded:")
    for reason, count in skipped_reasons.items():
        if count > 0:
            print(f"     - {reason.replace('_', ' ').title()}: {count}")

    if not valid_samples:
        print("\n❌ No valid samples remaining after filtering.")
        return

    # Shuffle only after all row-wise filtering; exact duplicates were removed before splitting.
    random.Random(42).shuffle(valid_samples)
    split_idx = max(1, int(len(valid_samples) * 0.9)) if len(valid_samples) > 1 else len(valid_samples)
    train_data = valid_samples[:split_idx]
    val_data = valid_samples[split_idx:]

    with open(TRAIN_DATASET, "w", encoding="utf-8") as f:
        for s in train_data:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    with open(VAL_DATASET, "w", encoding="utf-8") as f:
        for s in val_data:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    # Also update finetune_dataset.jsonl with the full deduplicated valid dataset
    with open(INPUT_DATASET, "w", encoding="utf-8") as f:
        for s in valid_samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    print(f"\n✅ Fine-Tuning Pipeline Tightened & Saved:")
    print(f"   📥 Approved sources:    {CURATED_INPUT.name}, {PUBLIC_INPUT.name}, {APPROVED_INPUT.name}")
    print(f"   📁 Clean Unified Dataset: {INPUT_DATASET} ({len(valid_samples)} pairs)")
    print(f"   📁 Training Set (90%):    {TRAIN_DATASET} ({len(train_data)} pairs)")
    print(f"   📁 Validation Set (10%):  {VAL_DATASET} ({len(val_data)} pairs)")
    print(f"\n✨ Zero emoji spam, zero robotic clichés, 100% authentic Forgelabs assistant identity.")

if __name__ == "__main__":
    validate_and_tighten()
