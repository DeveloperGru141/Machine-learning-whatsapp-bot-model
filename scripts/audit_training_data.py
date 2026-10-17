import json
import sqlite3
import sys
from pathlib import Path

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "bot.sqlite"

conn = sqlite3.connect(str(DB_PATH))
c = conn.cursor()

print("=" * 65)
print("📊 FORGELABS BOT — TRAINING DATA AUDIT REPORT")
print("=" * 65)

total_exemplars = c.execute("SELECT COUNT(*) FROM dialogue_exemplars").fetchone()[0]
total_ft = c.execute("SELECT COUNT(*) FROM fine_tuning_pairs").fetchone()[0]
chat_logs_count = c.execute("SELECT COUNT(*) FROM chat_logs").fetchone()[0]
contacts_count = c.execute("SELECT COUNT(*) FROM contacts").fetchone()[0]

train_path = DATA_DIR / "train.jsonl"
val_path = DATA_DIR / "validation.jsonl"
dataset_path = DATA_DIR / "finetune_dataset.jsonl"

train_cnt = len(train_path.read_text(encoding="utf-8").splitlines()) if train_path.exists() else 0
val_cnt = len(val_path.read_text(encoding="utf-8").splitlines()) if val_path.exists() else 0
dataset_cnt = len(dataset_path.read_text(encoding="utf-8").splitlines()) if dataset_path.exists() else 0

print(f"\n1. Database & Storage Statistics:")
print(f"   • SQLite dialogue_exemplars (Few-shot Dynamic Injections): {total_exemplars}")
print(f"   • SQLite fine_tuning_pairs (Fine-Tuning Candidates):       {total_ft}")
print(f"   • Live Chat Logs Logged:                                   {chat_logs_count}")
print(f"   • Contacts in Address Book:                                {contacts_count}")
print(f"   • Exported train.jsonl (for OpenRouter/HuggingFace):       {train_cnt} pairs")
print(f"   • Exported validation.jsonl:                               {val_cnt} pairs")

print(f"\n2. Top Most Frequent Responses in fine_tuning_pairs:")
top_ft = c.execute("SELECT assistant_response, COUNT(*) as cnt FROM fine_tuning_pairs GROUP BY assistant_response ORDER BY cnt DESC LIMIT 8").fetchall()
for resp, cnt in top_ft:
    pct = (cnt / total_ft) * 100
    print(f"   • [{cnt:4d}x | {pct:4.1f}%] \"{resp[:65]}...\"")

print(f"\n3. Top Most Frequent Responses in dialogue_exemplars:")
top_ex = c.execute("SELECT response_text, COUNT(*) as cnt FROM dialogue_exemplars GROUP BY response_text ORDER BY cnt DESC LIMIT 8").fetchall()
for resp, cnt in top_ex:
    pct = (cnt / total_exemplars) * 100
    print(f"   • [{cnt:4d}x | {pct:4.1f}%] \"{resp[:65]}...\"")

print(f"\n4. Breakdown by Dialogue Vibe Classification:")
vibes = c.execute("SELECT vibe_classification, COUNT(*) as cnt FROM dialogue_exemplars GROUP BY vibe_classification ORDER BY cnt DESC").fetchall()
for vibe, cnt in vibes:
    print(f"   • {vibe:15s}: {cnt:4d} exemplars")

conn.close()
