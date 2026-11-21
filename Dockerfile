# Not yet built/tested in the authoring environment. dist/ (optimised build) is optional: the server falls back to public/.
FROM node:22-slim
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend ./backend
COPY public ./public
ENV NODE_ENV=production PORT=8787 DB_FILE=/data/ak.db UPLOADS_DIR=/data/uploads BACKUP_DIR=/data/backups
RUN mkdir -p /data && chown -R node:node /data /app
USER node
WORKDIR /app/backend
EXPOSE 8787
CMD ["node", "src/server.js"]
