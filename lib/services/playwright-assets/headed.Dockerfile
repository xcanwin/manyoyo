ARG PLAYWRIGHT_MCP_BASE_IMAGE=mcr.microsoft.com/playwright/mcp:latest
FROM ${PLAYWRIGHT_MCP_BASE_IMAGE}

USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates xvfb x11vnc novnc websockify fluxbox && \
    update-ca-certificates && \
    apt-get clean && \
    rm -rf /tmp/* /var/tmp/* /var/log/apt /var/log/*.log /var/lib/apt/lists/*

COPY init-headed.sh /usr/local/bin/init-headed.sh
RUN chmod +x /usr/local/bin/init-headed.sh

ENTRYPOINT ["/usr/local/bin/init-headed.sh"]
