"""Print aggregate training-data quality metrics without exposing message text."""
import json
import re
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "bot.sqlite"
SENSITIVE = re.compile(
    r"(?:[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\+?\d[\d ()-]{7,}\d)\b|"
    r"\b\d{14,16}@?lid\b|(?:gsk_|rnd_|sk-|gh[pousr]_)[A-Za-z0-9_-]{16,})",
    re.IGNORECASE,
)


def inspect_jsonl(path: Path) -> tuple[int, int, int]:
    total = 0
    malformed = 0
    sensitive = 0
    if not path.exists():
        return total, malformed, sensitive
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            messages = record.get("messages", [])
            text = "\n".join(str(message.get("content", "")) for message in messages)
            total += 1
            sensitive += int(bool(SENSITIVE.search(text)))
        except (json.JSONDecodeError, AttributeError, TypeError):
            malformed += 1
    return total, malformed, sensitive


def main() -> None:
    for name in ("approved_training.jsonl", "train.jsonl", "validation.jsonl", "finetune_dataset.jsonl"):
        total, malformed, sensitive = inspect_jsonl(DATA_DIR / name)
        print(f"{name}: rows={total}, malformed={malformed}, sensitive_matches={sensitive}")

    if not DB_PATH.exists():
        return
    with sqlite3.connect(DB_PATH) as conn:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "fine_tuning_pairs" in tables:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(fine_tuning_pairs)")}
            source_column = "source_type" if "source_type" in columns else "'unknown'"
            for source, count in conn.execute(f"SELECT {source_column}, COUNT(*) FROM fine_tuning_pairs GROUP BY 1 ORDER BY 1"):
                print(f"database fine_tuning_pairs source={source}: rows={count}")


if __name__ == "__main__":
    main()
