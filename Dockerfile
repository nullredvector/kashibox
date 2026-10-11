FROM node:20-alpine

WORKDIR /app

# starplayer.js is baked into the image at build time
COPY starplayer.js ./starplayer.js
COPY server.js     ./server.js
COPY db_stars.js   ./db_stars.js
COPY entrypoint.sh ./entrypoint.sh
COPY assets        ./assets
COPY shell.html    ./shell.html

RUN chmod +x /app/entrypoint.sh

ENV ARCHIVE_DIR=/archive
ENV PORT=8080

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
