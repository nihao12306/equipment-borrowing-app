FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.js ./server.js
COPY demo-sheets.js ./demo-sheets.js
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
EXPOSE 8787

CMD ["npm", "start"]
