@echo off
cd /d "%~dp0"

if not exist node_modules (
    echo Instalando dependencias...
    call npm install
)

if not exist narma_crm.db (
    echo Creando base de datos y datos de ejemplo...
    call node seed.js
)

echo Cerrando instancias anteriores...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8765 "') do (
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

echo Iniciando Narma CRM...
start "Narma CRM" /min node server.js

echo Esperando que el servidor levante...
timeout /t 3 /nobreak >nul

start "" "http://localhost:8765"
