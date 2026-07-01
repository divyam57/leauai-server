FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads outputs

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
