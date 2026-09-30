FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "src/index.js"]
