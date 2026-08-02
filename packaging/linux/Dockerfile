FROM node:24.18.0-bullseye@sha256:87f8c5a4bb3e95e4a0b60e1a802edf24830c17a769535d738cc0aa65c1f5c299

ARG SOURCE_DATE_EPOCH
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}

RUN command -v g++ \
    && command -v make \
    && command -v objdump \
    && command -v python3 \
    && command -v xz

WORKDIR /workspace
COPY . .

RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm run package:linux:host \
    && npm run verify:linux-artifact
