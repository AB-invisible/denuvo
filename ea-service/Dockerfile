FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ea_minter.py ea_pc_sign.py ea_session.py ea_pending.py ea_login.py ea_auth.py ea_http.py ea_imap.py app.py ./

ENV EA_HOST=0.0.0.0 \
    PORT=8081

EXPOSE 8081

CMD ["python", "app.py"]
