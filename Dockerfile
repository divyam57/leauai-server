FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads outputs

ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.js"]
