import sqlite3
import sys

if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

conn = sqlite3.connect('data/bot.sqlite')
c = conn.cursor()

sql = '''
WITH LastPerChat AS (
  SELECT 
    id,
    chat_jid,
    sender_jid,
    sender_name,
    is_group,
    content_type,
    message_text,
    timestamp,
    ROW_NUMBER() OVER (PARTITION BY chat_jid ORDER BY id DESC) as rn
  FROM chat_logs
  WHERE is_group = 0
    AND NOT (sender_jid = 'bot' AND COALESCE(message_text, '') LIKE 'network slow small%')
)
SELECT chat_jid, sender_name, message_text, timestamp FROM LastPerChat
WHERE rn = 1 
  AND sender_jid != 'bot'
  AND (
    (message_text IS NOT NULL AND TRIM(message_text) != '')
    OR content_type = 'audio'
  )
ORDER BY timestamp ASC;
'''

rows = c.execute(sql).fetchall()
print(f"Total Unreplied DMs found in database: {len(rows)}")
for r in rows:
    print(f"  • {r[0]} ({r[1]}): \"{r[2][:60]}\"")
