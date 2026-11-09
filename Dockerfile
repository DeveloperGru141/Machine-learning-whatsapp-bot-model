FROM node:22-bookworm-slim

# Install Python 3, pip, ffmpeg, edge-tts (for voice notes), and yt-dlp (for video downloads)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    curl \
    && pip3 install --no-cache-dir --break-system-packages edge-tts==7.3.1 yt-dlp==2026.10.26 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies and build TypeScript
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY assets ./assets
COPY data/train.jsonl ./data/train.jsonl
COPY data/finetune_dataset.jsonl ./data/finetune_dataset.jsonl
COPY data/contacts.vcf ./data/contacts.vcf

RUN npm run build && mkdir -p /app/data/temp /app/sessions

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
