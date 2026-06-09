FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8081
ENV PORT=8081
CMD ["node", "server.js"]
