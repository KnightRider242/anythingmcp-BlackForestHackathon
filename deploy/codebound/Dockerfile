# SPDX-License-Identifier: AGPL-3.0-only
FROM node:22.23.0-alpine@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd AS watchdog-builder
RUN apk add --no-cache gcc musl-dev
COPY deploy/codebound/watchdog.c /watchdog.c
RUN cc -Os -Wall -Wextra -Werror -o /watchdog /watchdog.c

FROM node:22.23.0-alpine@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd
WORKDIR /sandbox
COPY deploy/codebound/runner.cjs /sandbox/runner.cjs
COPY --from=watchdog-builder /watchdog /sandbox/watchdog
USER 65534:65534
# PID 1 owns the timer; script code cannot stop a same-UID helper process.
ENTRYPOINT ["/sandbox/watchdog"]
