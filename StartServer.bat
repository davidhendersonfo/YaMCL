@echo off
rem Starts YaMCL and opens it in your browser. Close this window to stop it.
rem If this folder is a git checkout, it first pulls the latest version.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo The app isn't set up yet. Double-click Setup.bat first.
  pause
  exit /b 1
)

set "GIT="
for /f "delims=" %%G in ('where git 2^>nul') do if not defined GIT set "GIT=%%G"
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"
if not defined GIT if exist "C:\msys64\usr\bin\git.exe" set "GIT=C:\msys64\usr\bin\git.exe"

rem Everything below is one block on purpose: cmd reads it all before running it, so the pull can
rem replace this file without confusing the copy that's already running.
(
  if defined GIT if exist ".git" (
    echo Checking for updates...
    "%GIT%" pull --ff-only
    if errorlevel 1 (
      echo.
      echo Couldn't update, so starting the version you already have.
      echo If it says your local changes would be overwritten, see "Updating" in START HERE.txt.
      echo.
    )
  )
  rem Reinstall packages only when requirements.txt changed since the last install.
  fc /b requirements.txt ".venv\requirements.installed" >nul 2>nul
  if errorlevel 1 (
    echo The app needs new or updated packages, installing...
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt --quiet
    if errorlevel 1 (
      echo Package install failed. Copy the error above and send it to David.
      pause
      exit /b 1
    )
    copy /y requirements.txt ".venv\requirements.installed" >nul
  )
  start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:5050"
  ".venv\Scripts\python.exe" app.py
  pause
  exit /b 0
)
