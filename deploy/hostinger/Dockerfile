# Image for API + DayPush worker. Same artefact; override CMD for worker / migrate / seed.
FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
  && mkdir -p /app/.data/storage

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "run", "start:api"]
