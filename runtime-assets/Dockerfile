# syntax=docker/dockerfile:1
# C3 runtime image for Amazon Bedrock AgentCore Runtime (ARM64, HTTP protocol).
#
# Claude Code is NOT redistributed by C3: it is installed from the official npm
# package when this image is built in your own AWS account, under Anthropic's
# license terms (https://code.claude.com/docs/en/legal-and-compliance).
FROM --platform=linux/arm64 ghcr.io/astral-sh/uv:0.13.6 AS uv

FROM --platform=linux/arm64 node:26.12.1-bookworm-slim

ARG CLAUDE_CODE_VERSION
ARG MCP_PROXY_FOR_AWS_VERSION=1.7.0
ARG INSTALL_AWS_CLI=false

RUN test -n "$CLAUDE_CODE_VERSION" || (echo "CLAUDE_CODE_VERSION build arg is required" && exit 1)

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     bash ca-certificates curl git jq less procps python3 ripgrep tar unzip \
  && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

# Official AWS CLI v2, only when the agent should call AWS from Bash.
RUN if [ "$INSTALL_AWS_CLI" = "true" ]; then \
      curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip \
      && unzip -q /tmp/awscliv2.zip -d /tmp \
      && /tmp/aws/install \
      && rm -rf /tmp/aws /tmp/awscliv2.zip; \
    fi

# SigV4 bridge between Claude Code (stdio MCP) and the AgentCore Gateway.
ENV UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN uv tool install "mcp-proxy-for-aws-cli==${MCP_PROXY_FOR_AWS_VERSION}"

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

WORKDIR /opt/c3/entrypoint
COPY entrypoint/package.json entrypoint/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY entrypoint/*.mjs ./

COPY --chown=node:node workspace/ /workspace/
RUN git config --system --add safe.directory /workspace

ENV HOME=/home/node \
    CLAUDE_CODE_USE_BEDROCK=1 \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    C3_WORKSPACE_DIR=/workspace \
    NODE_ENV=production

USER node
WORKDIR /workspace
EXPOSE 8080
CMD ["node", "/opt/c3/entrypoint/server.mjs"]
