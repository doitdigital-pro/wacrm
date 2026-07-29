FROM node:20-alpine AS builder

WORKDIR /app

# Copiar dependencias
COPY package*.json ./
RUN npm ci

# Copiar el resto del código
COPY . .

# Construir la aplicación Next.js
# Nota: Next.js puede requerir algunas variables de entorno en tiempo de compilación.
RUN npm run build

# Imagen final de producción
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copiar archivos necesarios desde el builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3000

CMD ["npm", "start"]
