FROM node:20-alpine

WORKDIR /app

# ffmpeg makes the thumbnails of the Library's videos
RUN apk add --no-cache ffmpeg

# starplayer.js is baked into the image at build time
COPY starplayer.js ./starplayer.js
COPY server.js     ./server.js
COPY db_stars.js   ./db_stars.js
COPY tv_author.js  ./tv_author.js
COPY tv_sessions.js ./tv_sessions.js
COPY library.js    ./library.js
COPY genvideo.js   ./genvideo.js
COPY gen_jobs.js   ./gen_jobs.js
COPY scout_store.js ./scout_store.js
COPY entrypoint.sh ./entrypoint.sh
COPY assets        ./assets
COPY shell.html    ./shell.html
COPY cast-receiver.html ./cast-receiver.html

RUN chmod +x /app/entrypoint.sh

ENV ARCHIVE_DIR=/archive
ENV PORT=8080
# Where Settings -> Library starts browsing
ENV LIBRARY_START=/library

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
