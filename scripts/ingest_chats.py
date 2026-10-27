import re
import sys
import json
from pathlib import Path

# Ensure UTF-8 output on Windows terminal
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# Path references
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Regex patterns for WhatsApp chat export formats
WHATSAPP_TXT_PATTERNS = [
    # [15/10/2026, 10:20:15] Sender Name: Message
    re.compile(r"^\[(\d{1,2}/\d{1,2}/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]\s*([^:]+):\s*(.+)$"),
    # 15/10/2026, 10:20 - Sender Name: Message
    re.compile(r"^(\d{1,2}/\d{1,2}/\d{2,4}),\s*(\d{1,2}:\d{2}(?:\s*[APap][Mm])?)\s*-\s*([^:]+):\s*(.+)$"),
]

SYSTEM_MESSAGE_PATTERNS = [
    r"Messages and calls are end-to-end encrypted",
    r"<Media omitted>",
    r"This message was deleted",
    r"You deleted this message",
    r"missed (voice|video) call",
    r"created group",
    r"added you",
    r"changed the group description",
    r"changed the subject",
    r"waiting for this message",
    r"view once",
    r"\b(otp|verification code|security code|use code|sms code)\b",
    r"^\s*\d{4,8}\s*$",
    r"\b(credit alert|debit alert|acct no|available bal)\b",
    r"^[!./#$]\w+",
    r"\bforward this to\b",
    r"click (?:here|this link) to (?:win|claim)",
]

def is_system_message(text: str) -> bool:
    if not text or len(text.strip()) < 2:
        return True
    for pat in SYSTEM_MESSAGE_PATTERNS:
        if re.search(pat, text, re.IGNORECASE):
            return True
    return False

def parse_txt_chat(file_path: Path):
    """Parses a WhatsApp exported .txt chat file into clean conversational turns."""
    print(f"📖 Parsing exported chat: {file_path.name}")
    turns = []
    current_entry = None

    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line_str = line.strip()
            if not line_str:
                continue

            matched = False
            for pat in WHATSAPP_TXT_PATTERNS:
                m = pat.match(line_str)
                if m:
                    date_str, time_str, sender, content = m.groups()
                    if is_system_message(content):
                        continue
                    if current_entry:
                        turns.append(current_entry)
                    current_entry = {
                        "date": f"{date_str} {time_str}",
                        "sender": sender.strip(),
                        "text": content.strip()
                    }
                    matched = True
                    break

            if not matched and current_entry:
                current_entry["text"] += f"\n{line_str}"

        if current_entry:
            turns.append(current_entry)

    print(f"✅ Extracted {len(turns)} clean messages from {file_path.name}")
    return turns

SENSITIVE_DATA_PATTERNS = [
    re.compile(r"gsk_[a-zA-Z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"rnd_[a-zA-Z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{20,}", re.IGNORECASE),
    re.compile(r"sk-[a-zA-Z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}", re.IGNORECASE),
    re.compile(r"\b10\d{12,14}(?:@lid)?\b"),
    re.compile(r"(?:password|secret|apikey|api_key)\s*[:=]\s*\S+", re.IGNORECASE),
]

def main():
    import argparse

    parser = argparse.ArgumentParser(description="Import one reviewed WhatsApp text export into approved training data.")
    parser.add_argument("--input", required=True, type=Path, help="Explicit path to one WhatsApp .txt export")
    parser.add_argument("--assistant-sender", required=True, help="Exact sender label for the bot in that export")
    parser.add_argument("--output", type=Path, default=DATA_DIR / "approved_training.jsonl")
    args = parser.parse_args()
    if not args.input.is_file() or args.input.suffix.lower() != ".txt":
        parser.error("--input must point to one existing .txt export; directory scans and msgstore databases are unsupported")
    if not args.assistant_sender.strip():
        parser.error("--assistant-sender must not be empty")

    turns = parse_txt_chat(args.input)
    assistant_sender = args.assistant_sender.strip().casefold()
    system_prompt = (
        "You are a helpful WhatsApp conversation assistant. Answer naturally and clearly, "
        "match the other person's language and register, and avoid unnecessary personal data."
    )
    sensitive_patterns = SENSITIVE_DATA_PATTERNS + [
        re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}"),
        re.compile(r"(?<!\w)\+?\d[\d ()-]{6,}\d(?!\w)"),
        re.compile(r"[\w.+-]+@(?:s\.whatsapp\.net|lid|g\.us)", re.I),
    ]
    existing = set()
    if args.output.exists():
        with args.output.open("r", encoding="utf-8") as saved:
            for line in saved:
                try:
                    messages = json.loads(line).get("messages", [])
                    user = next(m["content"] for m in messages if m["role"] == "user")
                    reply = next(m["content"] for m in messages if m["role"] == "assistant")
                    existing.add((user.strip().casefold(), reply.strip().casefold()))
                except (ValueError, StopIteration, KeyError, TypeError, AttributeError):
                    continue

    additions = []
    for previous, answer in zip(turns, turns[1:]):
        if previous["sender"].casefold() == assistant_sender or answer["sender"].casefold() != assistant_sender:
            continue
        user_text, response = previous["text"].strip(), answer["text"].strip()
        if not (2 <= len(user_text) <= 4000 and 3 <= len(response) <= 4000):
            continue
        if any(pattern.search(user_text) or pattern.search(response) for pattern in sensitive_patterns):
            continue
        key = (user_text.casefold(), response.casefold())
        if key in existing:
            continue
        existing.add(key)
        additions.append({"messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": response},
        ]})

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("a", encoding="utf-8", newline="\n") as output:
        for sample in additions:
            output.write(json.dumps(sample, ensure_ascii=False) + "\n")
    print(f"Reviewed import complete: added {len(additions)} eligible pairs to {args.output.name}; message text was not printed.")

if __name__ == "__main__":
    main()
