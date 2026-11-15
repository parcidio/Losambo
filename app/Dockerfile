FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=4000

EXPOSE 4000
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/console-api/auth/providers >/dev/null || exit 1

CMD ["./node_modules/.bin/tsx", "src/server.ts"]
