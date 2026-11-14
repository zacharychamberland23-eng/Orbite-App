FROM python:3.13-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends iproute2 conntrack nftables ca-certificates fail2ban \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app/ /app/
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
CMD ["python", "-u", "server.py"]
