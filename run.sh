#!/bin/bash
# Ensure venv exists
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

# Activate venv
source venv/bin/activate

# Install dependencies (quietly if already installed)
# Install dependencies
pip install -r requirements.txt
pip install qwen-omni-utils # Ensure this is installed explicitly


# Run server
python server.py
