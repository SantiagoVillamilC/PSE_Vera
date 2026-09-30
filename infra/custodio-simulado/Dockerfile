FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.html ./
COPY src ./src
COPY server ./server
USER node
EXPOSE 8090
CMD ["node", "server/index.js"]
