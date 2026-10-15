import json
import sys
from pathlib import Path

# Ensure UTF-8 output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
INPUT_DATASET = DATA_DIR / "finetune_dataset.jsonl"
TRAIN_DATASET = DATA_DIR / "train.jsonl"
VAL_DATASET = DATA_DIR / "validation.jsonl"

def validate_and_tighten():
    print("=" * 60)
    print("🔍 WhatsApp Bot Fine-Tuning Dataset Validator & Tightener")
    print("=" * 60)

    if not INPUT_DATASET.exists():
        print(f"❌ Dataset file not found at: {INPUT_DATASET}")
        print("💡 Run 'python scripts/ingest_chats.py' after placing chat .txt files in data/ to generate it.")
        return

    valid_samples = []
    skipped_reasons = {
        "too_short": 0,
        "missing_roles": 0,
        "consecutive_roles": 0,
        "system_artifacts": 0,
        "duplicates": 0,
    }

    seen_pairs = set()

    with open(INPUT_DATASET, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, start=1):
            line_str = line.strip()
            if not line_str:
                continue

            try:
                data = json.loads(line_str)
            except json.JSONDecodeError:
                print(f"⚠️ Line {line_num}: Invalid JSON syntax. Skipping.")
                continue

            messages = data.get("messages", [])
            if len(messages) < 2:
                skipped_reasons["missing_roles"] += 1
                continue

            # Check required roles
            roles = [m.get("role") for m in messages]
            if "user" not in roles or "assistant" not in roles:
                skipped_reasons["missing_roles"] += 1
                continue

            # Check content quality
            user_msg = next((m.get("content", "") for m in messages if m.get("role") == "user"), "")
            asst_msg = next((m.get("content", "") for m in messages if m.get("role") == "assistant"), "")

            # Filter trivial replies
            if len(user_msg.strip()) < 3 or len(asst_msg.strip()) < 3:
                skipped_reasons["too_short"] += 1
                continue

            # Deduplication
            pair_key = (user_msg.strip().lower(), asst_msg.strip().lower())
            if pair_key in seen_pairs:
                skipped_reasons["duplicates"] += 1
                continue
            seen_pairs.add(pair_key)

            valid_samples.append(data)

    print(f"\n📊 Dataset Analysis:")
    print(f"   • Total Raw Samples:      {len(valid_samples) + sum(skipped_reasons.values())}")
    print(f"   • High-Quality Valid:     {len(valid_samples)}")
    print(f"   • Filtered Out / Tightened:")
    for reason, count in skipped_reasons.items():
        if count > 0:
            print(f"     - {reason.replace('_', ' ').capitalize()}: {count}")

    if len(valid_samples) == 0:
        print("\n⚠️ No valid training samples found yet. Ingest your WhatsApp chat exports to populate.")
        return

    # Train / Validation Split (90% Train, 10% Validation)
    split_idx = int(len(valid_samples) * 0.9)
    train_data = valid_samples[:split_idx]
    val_data = valid_samples[split_idx:] if len(valid_samples) > 10 else valid_samples

    with open(TRAIN_DATASET, "w", encoding="utf-8") as f:
        for s in train_data:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    with open(VAL_DATASET, "w", encoding="utf-8") as f:
        for s in val_data:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    print(f"\n✅ Dataset Cleaned, Tightened, and Split:")
    print(f"   📁 Training Set (90%):    {TRAIN_DATASET} ({len(train_data)} samples)")
    print(f"   📁 Validation Set (10%):  {VAL_DATASET} ({len(val_data)} samples)")
    print(f"\n🚀 Ready for Fine-Tuning upload to Groq / OpenAI / Unsloth!")

if __name__ == "__main__":
    validate_and_tighten()
