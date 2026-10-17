import os
import re
import sys
import json
import sqlite3
from pathlib import Path
from datetime import datetime

# Ensure UTF-8 output on Windows terminal
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# Path references
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "bot.sqlite"
FINETUNE_OUTPUT = DATA_DIR / "finetune_dataset.jsonl"

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
]

def is_system_message(text: str) -> bool:
    for pat in SYSTEM_MESSAGE_PATTERNS:
        if re.search(pat, text, re.IGNORECASE):
            return True
    return False

def init_db(conn: sqlite3.Connection):
    cursor = conn.cursor()
    cursor.executescript("""
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS chat_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_jid TEXT NOT NULL,
            sender_jid TEXT NOT NULL,
            sender_name TEXT,
            is_group INTEGER NOT NULL,
            content_type TEXT NOT NULL,
            message_text TEXT,
            sticker_filename TEXT,
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dialogue_exemplars (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_jid TEXT NOT NULL,
            context_text TEXT NOT NULL,
            response_text TEXT,
            response_type TEXT NOT NULL,
            sticker_filename TEXT,
            vibe_classification TEXT,
            quality_score REAL DEFAULT 1.0,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS fine_tuning_pairs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            system_prompt TEXT NOT NULL,
            user_message TEXT NOT NULL,
            assistant_response TEXT NOT NULL,
            tools_invoked TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_jid TEXT NOT NULL,
            fact TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            updated_at INTEGER NOT NULL,
            UNIQUE(user_jid, fact)
        );
    """)
    conn.commit()

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

def parse_msgstore_sqlite(msgstore_path: Path):
    """Parses a decrypted WhatsApp SQLite database file."""
    print(f"📖 Parsing decrypted msgstore database: {msgstore_path.name}")
    try:
        source_conn = sqlite3.connect(msgstore_path)
        cur = source_conn.cursor()
        tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        
        turns = []
        target_tbl = None
        for cand in ["message", "messages"]:
            if cand in tables:
                target_tbl = cand
                break

        if target_tbl:
            cols = [info[1] for info in cur.execute(f"PRAGMA table_info({target_tbl})").fetchall()]
            text_col = "text_data" if "text_data" in cols else ("data" if "data" in cols else None)
            from_me_col = "from_me" if "from_me" in cols else ("key_from_me" if "key_from_me" in cols else None)

            if text_col and from_me_col:
                query = f"SELECT {text_col}, {from_me_col} FROM {target_tbl} WHERE {text_col} IS NOT NULL AND {text_col} != ''"
                rows = cur.execute(query).fetchall()
                for text_val, from_me in rows:
                    if not text_val or is_system_message(text_val):
                        continue
                    turns.append({
                        "sender": "Me" if from_me == 1 else "Friend",
                        "text": text_val.strip()
                    })

        source_conn.close()
        print(f"✅ Extracted {len(turns)} clean messages from {msgstore_path.name}")
        return turns
    except Exception as e:
        print(f"⚠️ Error reading {msgstore_path.name}: {e}")
        return []

SENSITIVE_DATA_PATTERNS = [
    re.compile(r"gsk_[a-zA-Z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"rnd_[a-zA-Z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"(?:ghp|gho|ghu|ghs|ghr|github_pat)_[a-zA-Z0-9_]{20,}", re.IGNORECASE),
    re.compile(r"sk-[a-zA-Z0-9_-]{20,}", re.IGNORECASE),
    re.compile(r"eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}", re.IGNORECASE),
    re.compile(r"\b10\d{12,14}(?:@lid)?\b"),
    re.compile(r"(?:password|secret|apikey|api_key)\s*[:=]\s*\S+", re.IGNORECASE),
]

def contains_sensitive_data(text: str) -> bool:
    for pat in SENSITIVE_DATA_PATTERNS:
        if pat.search(text):
            return True
    return False

def ingest_turns(conn: sqlite3.Connection, turns: list, chat_name: str):
    """Processes turns into dialogue exemplars, training pairs, and knowledge."""
    cursor = conn.cursor()
    ingested_pairs = 0

    system_prompt = (
        "You are Forgelabs assistant, a sharp, witty, and culturally savvy real WhatsApp user "
        "living inside WhatsApp chats. Your creator is Ademola. Talk naturally like a real person, "
        "NO robotic AI clichés, authentic expressive emojis (1-2 emojis max per reply)."
    )

    now = int(datetime.now().timestamp() * 1000)

    for i in range(len(turns) - 1):
        turn_a = turns[i]
        turn_b = turns[i + 1]

        if turn_a["sender"] != turn_b["sender"]:
            user_text = turn_a["text"]
            resp_text = turn_b["text"]

            if len(user_text) < 2 or len(resp_text) < 2:
                continue

            if contains_sensitive_data(user_text) or contains_sensitive_data(resp_text):
                continue

            cursor.execute("""
                INSERT INTO chat_logs (chat_jid, sender_jid, sender_name, is_group, content_type, message_text, timestamp)
                VALUES (?, ?, ?, 1, 'text', ?, ?)
            """, (chat_name, turn_a["sender"], turn_a["sender"], user_text, now))

            cursor.execute("""
                INSERT INTO dialogue_exemplars (chat_jid, context_text, response_text, response_type, vibe_classification, quality_score, created_at)
                VALUES (?, ?, ?, 'text', 'natural_dialogue', 1.0, ?)
            """, (chat_name, user_text, resp_text, now))

            cursor.execute("""
                INSERT INTO fine_tuning_pairs (system_prompt, user_message, assistant_response, tools_invoked, created_at)
                VALUES (?, ?, ?, '[]', ?)
            """, (system_prompt, user_text, resp_text, now))

            ingested_pairs += 1

    conn.commit()
    print(f"🎉 Ingested {ingested_pairs} training pairs into database from {chat_name}")
    return ingested_pairs

def export_jsonl_dataset(conn: sqlite3.Connection):
    """Exports all fine_tuning_pairs to finetune_dataset.jsonl"""
    cursor = conn.cursor()
    rows = cursor.execute("""
        SELECT system_prompt, user_message, assistant_response
        FROM fine_tuning_pairs
        ORDER BY id ASC
    """).fetchall()

    with open(FINETUNE_OUTPUT, "w", encoding="utf-8") as f:
        for sys_p, user_msg, asst_resp in rows:
            record = {
                "messages": [
                    {"role": "system", "content": sys_p},
                    {"role": "user", "content": user_msg},
                    {"role": "assistant", "content": asst_resp}
                ]
            }
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(f"📁 Exported {len(rows)} training examples to: {FINETUNE_OUTPUT}")

def main():
    print("=" * 60)
    print("🚀 WhatsApp Chat History Cleaner & Fine-Tuning Pipeline")
    print("=" * 60)

    conn = sqlite3.connect(DB_PATH)
    init_db(conn)

    search_dirs = [
        Path.home() / "Downloads",
        DATA_DIR,
        BASE_DIR
    ]

    # 1. Search for decrypted SQLite msgstore databases
    db_files = []
    for d in search_dirs:
        if d.exists():
            db_files.extend(list(d.glob("msgstore*.db")))

    for db_f in db_files:
        turns = parse_msgstore_sqlite(db_f)
        if turns:
            ingest_turns(conn, turns, db_f.stem)

    # 2. Search for any .txt exported chats
    txt_files = []
    for d in search_dirs:
        if d.exists():
            txt_files.extend(list(d.glob("*.txt")))
            txt_files.extend(list(d.glob("WhatsApp Chat*.txt")))

    valid_txt = [f for f in set(txt_files) if "Read Me" not in f.name]

    if valid_txt:
        print(f"🔍 Found {len(valid_txt)} chat export text file(s):")
        for f in valid_txt:
            turns = parse_txt_chat(f)
            ingest_turns(conn, turns, f.stem)

    # 3. Check for .crypt14 files and notify user
    crypt_files = []
    for d in search_dirs:
        if d.exists():
            crypt_files.extend(list(d.glob("*.crypt*")))

    if crypt_files and not db_files and not valid_txt:
        print(f"ℹ️ Found {len(crypt_files)} encrypted backup file(s): {[c.name for c in crypt_files]}")
        print("🔒 .crypt14 files are AES-256-GCM encrypted WhatsApp database backups.")
        print("💡 To ingest them:")
        print("   1. If you have the 64-digit encryption key or 'key' file, we can decrypt it.")
        print("   2. OR simply export your most active chats from WhatsApp on your phone:")
        print("      Open Chat > 3 dots > More > Export Chat > Without Media > save .txt into data/")

    # 4. Export updated fine-tuning dataset
    export_jsonl_dataset(conn)
    conn.close()

if __name__ == "__main__":
    main()
