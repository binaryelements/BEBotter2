FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash curl git jq python3 ripgrep openssh-client ca-certificates \
 && apt-get clean \
 && useradd --create-home --shell /bin/bash bot
USER bot
WORKDIR /home/bot
CMD ["sleep", "infinity"]
