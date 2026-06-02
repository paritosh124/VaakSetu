# Relay server image. Render can also auto-detect via nixpacks (no Dockerfile
# needed) — this is here for Fly.io / self-host / reproducibility.
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
