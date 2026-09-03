#!/bin/bash
apt-get update
apt-get install -y \
  libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 \
  libgbm1 libxkbcommon0 libxshmfence1 libcups2 \
  libxcomposite1 libxcursor1 libxdamage1 libxext6 \
  libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 \
  libxtst6 libpango-1.0-0 libpangocairo-1.0-0 libcairo2 \
  libasound2t64 \
  python3 python3-pip
python3 -m pip install -r miruro-api/requirements.txt || true
npm install
