FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY requirements.txt ./
RUN pip3 install --break-system-packages --no-cache-dir --target=/app/python_deps -r requirements.txt

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PYTHONPATH=/app/python_deps
ENV PORT=10000

EXPOSE 10000

CMD ["npm", "start"]
