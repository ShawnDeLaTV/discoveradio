# Kiwi IRC n'a pas d'image Docker officielle : on compile le client web depuis les sources, puis nginx sert les fichiers statiques.
FROM node:20-alpine AS build
RUN apk add --no-cache git
ARG KIWI_REF=master
WORKDIR /src
RUN git clone --depth 1 --branch ${KIWI_REF} https://github.com/kiwiirc/kiwiirc.git .
RUN yarn install --frozen-lockfile || yarn install
RUN yarn build

FROM nginx:alpine
COPY --from=build /src/dist /usr/share/nginx/html
COPY theme /usr/share/nginx/html/static/themes/discoveradio
EXPOSE 80