@echo off
cd /d %~dp0

rem pip temp (~3GB) and OCR scratch files both live here, not on C:
set "TMP=%~dp0pip-temp"
set "TEMP=%~dp0pip-temp"
if not exist "%TMP%" mkdir "%TMP%"

rem keep the ~400MB OCR model cache off C: as well
set "HF_HOME=%~dp0hf-cache"

rem .deps-ok is written only after installs succeed, so an interrupted
rem install resumes instead of being skipped forever
if not exist venv\.deps-ok (
    echo First run: creating venv and installing dependencies. This takes a while...
    if not exist venv\Scripts\python.exe (
        py -3.12 -m venv venv || py -3.11 -m venv venv || py -3.10 -m venv venv
    )
    if not exist venv\Scripts\python.exe (
        echo.
        echo ERROR: Python 3.10, 3.11, or 3.12 is required but none was found.
        echo Install Python 3.12 from https://www.python.org/downloads/
        echo then run this script again.
        pause
        exit /b 1
    )
    venv\Scripts\python -m pip install --upgrade pip
    venv\Scripts\pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
    if errorlevel 1 goto :pipfail
    venv\Scripts\pip install -r requirements.txt
    if errorlevel 1 goto :pipfail
    echo ok > venv\.deps-ok
)

goto :run

:pipfail
echo.
echo ERROR: dependency install failed - see output above.
pause
exit /b 1

:run

venv\Scripts\python server.py
pause
