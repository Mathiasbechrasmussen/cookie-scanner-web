# Dockerfile
# Base image har allerede Chromium + alle dependencies
FROM mcr.microsoft.com/playwright:v1.46.0-jammy

WORKDIR /app

# Installer npm-deps først (cache-venligt)
COPY package*.json ./
RUN npm ci

# Kopiér resten af koden
COPY . .

ENV NODE_ENV=production

# Render sætter selv PORT env; server.js bruger process.env.PORT || 3000
EXPOSE 3000
CMD ["node", "server.js"]
