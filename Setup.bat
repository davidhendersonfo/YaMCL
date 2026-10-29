@echo off
rem One-time setup: Python 3.13, a private environment (.venv) and the packages the app needs.
cd /d "%~dp0"
echo.
echo === YaMCL setup ===
echo.

where py >nul 2>nul
if errorlevel 1 (
  echo Python isn't installed.
  echo Install "Python Install Manager" from the Microsoft Store, then run Setup.bat again.
  echo.
  pause
  exit /b 1
)

rem The Databricks connector doesn't build on Python 3.14 yet, so the app uses 3.13.
py -3.13 --version >nul 2>nul
if errorlevel 1 (
  echo Installing Python 3.13 next to whatever you already have...
  py install 3.13
  py -3.13 --version >nul 2>nul
  if errorlevel 1 (
    echo.
    echo Couldn't install Python 3.13 automatically.
    echo Open a terminal, run:  py install 3.13   then run Setup.bat again.
    echo.
    pause
    exit /b 1
  )
)

if exist ".venv\Scripts\python.exe" (
  echo Found an existing environment, updating it.
) else (
  echo Creating the app's environment...
  py -3.13 -m venv .venv
  if errorlevel 1 (
    echo Couldn't create the environment.
    pause
    exit /b 1
  )
)

echo Installing packages (this takes a minute the first time)...
".venv\Scripts\python.exe" -m pip install --upgrade pip --quiet
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo Package install failed. Copy the error above and send it to David.
  pause
  exit /b 1
)
copy /y requirements.txt ".venv\requirements.installed" >nul

echo.
echo Setup finished. Double-click StartServer.bat to run the app.
echo.
pause
