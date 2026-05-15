@echo off
chcp 65001 >nul
echo.

:: Python pruefen
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo Server laeuft auf http://localhost:8080
    echo Schliesse dieses Fenster um den Server zu stoppen.
    echo.
    python -m http.server 8080
    goto :end
)

:: Node.js / npx pruefen
npx --version >nul 2>&1
if %errorlevel% == 0 (
    echo Server laeuft auf http://localhost:8080
    echo Schliesse dieses Fenster um den Server zu stoppen.
    echo.
    npx serve -p 8080 -s .
    goto :end
)

echo FEHLER: Kein Server gefunden.
echo.
echo Bitte eine der folgenden Optionen installieren:
echo   - Python:  https://www.python.org/downloads/
echo   - Node.js: https://nodejs.org/
echo.
pause
é
:end
