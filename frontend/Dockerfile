# Build stage
FROM node:slim AS ui
WORKDIR /app

ARG VITE_AZURE_CLIENT_ID
ARG VITE_AZURE_AUTHORITY
ARG VITE_AZURE_REDIRECT_URI
ARG VITE_API_SCOPE
ARG VITE_API_URL
ARG VITE_AZURE_DOMAIN_HINT
ENV VITE_AZURE_CLIENT_ID=$VITE_AZURE_CLIENT_ID \
	VITE_AZURE_AUTHORITY=$VITE_AZURE_AUTHORITY \
	VITE_AZURE_REDIRECT_URI=$VITE_AZURE_REDIRECT_URI \
	VITE_API_SCOPE=$VITE_API_SCOPE \
	VITE_API_URL=$VITE_API_URL \
	VITE_AZURE_DOMAIN_HINT=$VITE_AZURE_DOMAIN_HINT

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of your application's source code
COPY . .

# Build the project
RUN npm run build

FROM nginx:alpine

# Copy built assets into default nginx dir
WORKDIR /usr/share/nginx/html
COPY --from=ui /app/dist .

# copy in your nginx config (replaces the default server block)
COPY ./nginx/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
