@echo off
cd /d %~dp0

if not exist venv (
    echo First run: creating venv and installing dependencies. This takes a while...
    py -3.12 -m venv venv
    venv\Scripts\python -m pip install --upgrade pip
    venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu121
    venv\Scripts\pip install -r requirements.txt
)

venv\Scripts\python server.py
pause
